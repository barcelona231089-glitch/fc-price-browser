import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { chromium, type Browser, type BrowserContext, type Page, type Request, type Response } from "playwright";
import {
  candidateReasons, countsFor, inferJsonSchema, inferRequestType,
  safeRequestUrl, sanitizeUrl, SENSITIVE_NAME,
  type TrafficMetadata,
} from "@workspace/traffic-core";
export { safeRequestUrl, sanitizeUrl } from "@workspace/traffic-core";

const MAX_RECORDED_REQUESTS = 300;
const MAX_PAGE_REQUESTS = 800;
const MAX_JSON_BYTES = 512 * 1024;
const NAVIGATION_TIMEOUT_MS = 15_000;

export type CapturedRequest = TrafficMetadata & { startedAtMs: number };
export type TrafficAnalysis = {
  url: string; capturedAt: string; durationMs: number; requestCount: number; blockedCount: number;
  counts: ReturnType<typeof countsFor>; requests: TrafficMetadata[]; warnings: string[];
};
/** Only tests can inject a fixture host policy; production routes use the defaults. */
export type TrafficRuntime = {
  isPublicHostname?: (hostname: string) => Promise<boolean>;
  launchBrowser?: () => Promise<Browser>;
};

function privateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some(v => !Number.isInteger(v) || v < 0 || v > 255)) return true;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || b === 0 || b === 2 && c === 0))
    || (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100))
    || (a === 203 && b === 0 && c === 113) || a >= 224;
}

export function isPublicAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (isIP(host) === 4) return !privateIpv4(host);
  if (isIP(host) !== 6) return false;
  if (/^(?:fc|fd|fe[89ab]|ff)/.test(host) || host === "::" || host === "::1" || host.startsWith("2001:db8:")) return false;
  // URL canonicalization converts mapped IPv4 to hexadecimal, e.g. ::ffff:7f00:1.
  const halves = host.split("::");
  const parse = (value: string) => value ? value.split(":").flatMap(part => part.includes(".") ? (() => { const a = part.split(".").map(Number); return [(a[0] << 8) | a[1], (a[2] << 8) | a[3]]; })() : [parseInt(part, 16)]) : [];
  const left = parse(halves[0]);
  const right = parse(halves[1] ?? "");
  const words = halves.length === 2 ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill(0), ...right] : left;
  if (words.length !== 8) return false;
  if (words.slice(0, 5).every(v => v === 0) && words[5] === 0xffff) {
    return !privateIpv4(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  }
  if (words.slice(0, 6).every(v => v === 0)) return false;
  // Global unicast only, excluding transition mechanisms and documentation ranges.
  return (words[0] & 0xe000) === 0x2000 && !(words[0] === 0x2001 && words[1] === 0) && words[0] !== 0x2002;
}

const publicDnsCache = new Map<string, number>();

export async function isPublicHostname(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || /^(?:localhost)$|\.(?:localhost|local|internal|test)$/.test(host)) return false;
  if (isIP(host)) return isPublicAddress(host);
  try {
    const results = await lookup(host, { all: true, verbatim: true });
    return results.length > 0 && results.every(entry => isPublicAddress(entry.address));
  } catch {
    if (process.env.TRAFFIC_DNS_OVER_HTTPS !== "1") return false;
    if ((publicDnsCache.get(host) ?? 0) > Date.now()) return true;
    try {
      const answers = await Promise.all(["A", "AAAA"].map(async type => {
        const url = new URL("https://cloudflare-dns.com/dns-query");
        url.searchParams.set("name", host);
        url.searchParams.set("type", type);
        const response = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error("DNS resolution failed.");
        const data = await response.json() as { Status?: number; Answer?: Array<{ type: number; data: string; TTL?: number }> };
        if (data.Status !== 0) throw new Error("DNS resolution failed.");
        const entries = (data.Answer ?? []).filter(entry => [1, 28].includes(entry.type));
        return { addresses: entries.map(entry => entry.data), ttl: entries.length ? Math.min(...entries.map(entry => entry.TTL ?? 0)) : 30 };
      }));
      const addresses = answers.flatMap(answer => answer.addresses);
      const allowed = addresses.length > 0 && addresses.every(isPublicAddress);
      if (allowed) {
        if (publicDnsCache.size > 1000) publicDnsCache.clear();
        publicDnsCache.set(host, Date.now() + Math.max(0, Math.min(30, ...answers.map(answer => answer.ttl))) * 1000);
      }
      return allowed;
    } catch { return false; }
  }
}

export function browserExecutablePath(): string {
  const windowsBrowsers = process.platform === "win32" ? [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Microsoft/Edge/Application/msedge.exe"),
  ] : [];
  const candidates = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, "/repl/tools/bin/chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser", chromium.executablePath(), ...windowsBrowsers].filter((v): v is string => Boolean(v));
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error("Chromium is missing. Run pnpm setup:browser or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.");
  return found;
}

export function launchCaptureBrowser(): Promise<Browser> {
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  const proxy = proxyUrl ? (() => {
    const parsed = new URL(proxyUrl);
    return { server: parsed.origin, ...(parsed.username ? { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) } : {}) };
  })() : undefined;
  return chromium.launch({ headless: true, executablePath: browserExecutablePath(), proxy, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}

function contentTypeFor(response: Response): string | null {
  const media = response.headers()["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  return media && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(media) ? media : null;
}

export function graphqlRequest(request: Request): boolean {
  try {
    const body = request.postDataJSON() as Record<string, unknown> | null;
    const query = body?.query ?? new URL(request.url()).searchParams.get("query");
    return typeof query === "string" && /^\s*(?:query\b|mutation\b|subscription\b|\{)/.test(query);
  } catch { return false; }
}

function containsSensitiveBody(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (Array.isArray(value)) return value.some(v => containsSensitiveBody(v, depth + 1));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => SENSITIVE_NAME.test(key) || containsSensitiveBody(child, depth + 1));
}

export function attachCaptureListeners(page: Page, requests: CapturedRequest[], isRecording: () => boolean = () => true) {
  const handles = new WeakMap<Request, { record: CapturedRequest; epoch: number; document: boolean }>();
  const tasks = new Set<Promise<void>>();
  const sockets: CapturedRequest[] = [];
  const socketUrls = new Map<string, string>();
  const pendingStatuses = new Map<string, number>();
  let nextId = 1;
  let epoch = 0;
  let attached = true;
  const valid = (at: number) => attached && at === epoch;
  const candidate = (record: CapturedRequest) => {
    record.candidateReasons = candidateReasons(record);
    record.isApiCandidate = record.candidateReasons.length > 0;
  };
  const add = (rawUrl: string, method: string, resourceType: string): CapturedRequest | null => {
    if (!attached || !isRecording() || requests.length >= MAX_RECORDED_REQUESTS) return null;
    try {
      const url = sanitizeUrl(rawUrl);
      const parsed = new URL(url);
      const record: CapturedRequest = {
        id: `request-${nextId++}`, url, hostname: parsed.hostname, path: parsed.pathname,
        method, statusCode: null, contentType: null, startedAt: new Date().toISOString(),
        startedAtMs: performance.now(), durationMs: null,
        type: resourceType === "websocket" ? "websocket" : inferRequestType(parsed.pathname, null),
        resourceType, jsonSchema: null, isApiCandidate: false, candidateReasons: [],
      };
      candidate(record);
      return record;
    } catch { return null; }
  };
  const onRequest = (request: Request) => {
    const resource = request.resourceType();
    const document = resource === "document" && request.isNavigationRequest();
    if (!["fetch", "xhr"].includes(resource) && !document) return;
    const record = add(request.url(), request.method(), resource);
    if (!record) return;
    if (graphqlRequest(request)) record.type = "graphql";
    candidate(record);
    handles.set(request, { record, epoch, document });
    if (!document) requests.push(record);
  };
  const onResponse = (response: Response) => {
    const handle = handles.get(response.request());
    if (!handle || !valid(handle.epoch)) return;
    const { record, document } = handle;
    record.statusCode = response.status();
    record.contentType = contentTypeFor(response);
    if (record.type !== "graphql") record.type = inferRequestType(record.path, record.contentType);
    candidate(record);
    const json = record.contentType === "application/json" || record.contentType?.endsWith("+json") || record.contentType?.startsWith("application/graphql");
    if (document) {
      if (!json || requests.length >= MAX_RECORDED_REQUESTS) { handles.delete(response.request()); return; }
      requests.push(record);
    }
    if (!json || Number(response.headers()["content-length"] ?? 0) > MAX_JSON_BYTES) return;
    const task = (async () => {
      try {
        const bytes = await response.body();
        if (!valid(handle.epoch) || bytes.byteLength > MAX_JSON_BYTES) return;
        // Body lives only in this callback. Store neither bytes nor parsed values.
        record.jsonSchema = inferJsonSchema(JSON.parse(bytes.toString("utf8")));
      } catch { record.jsonSchema = null; }
    })();
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  };
  const finish = (request: Request) => {
    const handle = handles.get(request);
    if (handle && valid(handle.epoch)) handle.record.durationMs = Math.max(0, Math.round((performance.now() - handle.record.startedAtMs) * 10) / 10);
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfinished", finish);
  page.on("requestfailed", finish);
  page.on("websocket", socket => {
    const record = add(socket.url(), "GET", "websocket");
    if (!record) return;
    const at = epoch;
    record.statusCode = pendingStatuses.get(record.url) ?? null;
    pendingStatuses.delete(record.url);
    sockets.push(record);
    requests.push(record);
    socket.on("close", () => { if (valid(at)) record.durationMs = Math.max(0, Math.round((performance.now() - record.startedAtMs) * 10) / 10); });
  });
  const ready = (async () => {
    const cdp = await page.context().newCDPSession(page);
    cdp.on("Network.webSocketCreated", event => {
      try { socketUrls.set(event.requestId, sanitizeUrl(event.url)); } catch { /* Unsupported URL. */ }
    });
    cdp.on("Network.webSocketHandshakeResponseReceived", event => {
      const url = socketUrls.get(event.requestId);
      if (!url) return;
      const record = sockets.find(socket => socket.url === url && socket.statusCode === null);
      if (record) record.statusCode = event.response.status;
      else pendingStatuses.set(url, event.response.status);
    });
    cdp.on("Network.webSocketClosed", event => socketUrls.delete(event.requestId));
    await cdp.send("Network.enable");
  })().catch(() => undefined);
  return {
    ready,
    reset() { epoch += 1; requests.length = 0; sockets.length = 0; socketUrls.clear(); pendingStatuses.clear(); },
    async drain(timeout = 1000) {
      if (!tasks.size) return;
      let timer: ReturnType<typeof setTimeout>;
      await Promise.race([Promise.allSettled([...tasks]), new Promise<void>(resolve => { timer = setTimeout(resolve, timeout); })]);
      clearTimeout(timer!);
    },
    snapshot(): TrafficMetadata[] {
      const now = performance.now();
      return requests.slice(0, MAX_RECORDED_REQUESTS).map(({ startedAtMs, ...record }) => ({ ...record, durationMs: record.durationMs ?? Math.max(0, Math.round((now - startedAtMs) * 10) / 10) }));
    },
    dispose() { attached = false; epoch += 1; socketUrls.clear(); pendingStatuses.clear(); },
  };
}
export type CaptureController = ReturnType<typeof attachCaptureListeners>;

/** The same network policy is applied to automatic and interactive capture. */
export async function installSafeRouting(context: BrowserContext, onBlocked: () => void, runtime: TrafficRuntime = {}) {
  const publicHost = runtime.isPublicHostname ?? isPublicHostname;
  let requestCount = 0;
  // Chromium's redirect requests can skip Playwright's route handler. A second
  // protocol session validates those requests before Chromium sends them.
  const protectPage = async (page: Page) => {
    const guard = await context.newCDPSession(page);
    guard.on("Fetch.requestPaused", event => {
      void (async () => {
        try {
          const url = safeRequestUrl(event.request.url);
          if (!url || !(await publicHost(new URL(url).hostname))) {
            onBlocked();
            await guard.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
            return;
          }
          const headers = Object.entries(event.request.headers).filter(([name]) => !SENSITIVE_NAME.test(name) && name.toLowerCase() !== "referer").map(([name, value]) => ({ name, value: String(value) }));
          await guard.send("Fetch.continueRequest", { requestId: event.requestId, headers });
        } catch {
          try { await guard.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }); } catch { /* Request or page already closed. */ }
        }
      })();
    });
    await guard.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  };
  for (const page of context.pages()) await protectPage(page);
  context.on("page", page => { void protectPage(page).catch(() => undefined); });
  await context.route("**/*", async route => {
    try {
      const request = route.request();
      const url = safeRequestUrl(request.url());
      if (!url || ++requestCount > MAX_PAGE_REQUESTS || !(await publicHost(new URL(url).hostname))) {
        onBlocked(); await route.abort("blockedbyclient"); return;
      }
      // Never submit credentials or send opaque authenticated request bodies.
      if (request.postData()) {
        let body: unknown;
        try { body = request.postDataJSON(); } catch { body = Object.fromEntries(new URLSearchParams(request.postData() ?? "")); }
        if (containsSensitiveBody(body)) { onBlocked(); await route.abort("blockedbyclient"); return; }
      }
      const headers = request.headers();
      // Keep only ordinary browser/content headers. No custom credentials or Referer.
      const allowed = /^(?:accept|accept-language|content-type|origin|range|cache-control|pragma|user-agent|sec-fetch-(?:dest|mode|site|user)|sec-ch-ua(?:-mobile|-platform)?|upgrade-insecure-requests)$/i;
      for (const name of Object.keys(headers)) if (!allowed.test(name) || SENSITIVE_NAME.test(name)) delete headers[name];
      // Relay one real response at a time. Browser redirects then enter this guard
      // again; automatic redirect following would skip the private-host checks.
      // Empty Cookie overrides prevent the request context's cookie jar being used.
      const upstream = await route.fetch({ url, headers: { ...headers, cookie: "" }, maxRedirects: 0, maxRetries: 0, timeout: NAVIGATION_TIMEOUT_MS });
      try {
        const responseHeaders = upstream.headers();
        if ([301, 302, 303, 307, 308].includes(upstream.status()) && responseHeaders.location) {
          const target = safeRequestUrl(new URL(responseHeaders.location, url).toString());
          if (!target || !(await publicHost(new URL(target).hostname))) {
            onBlocked();
            await route.abort("blockedbyclient");
            return;
          }
        }
        for (const name of Object.keys(responseHeaders)) if (SENSITIVE_NAME.test(name)) delete responseHeaders[name];
        await context.clearCookies();
        await route.fulfill({ response: upstream, headers: responseHeaders });
      } finally { await upstream.dispose(); }
    } catch {
      onBlocked();
      try { await route.abort("blockedbyclient"); } catch { /* Route already canceled. */ }
    }
  });
  await context.routeWebSocket("**/*", async route => {
    const url = safeRequestUrl(route.url());
    if (!url || !(await publicHost(new URL(url).hostname))) {
      onBlocked(); route.close({ code: 1008, reason: "Public unauthenticated connections only." }); return;
    }
    await context.clearCookies();
    route.connectToServer();
  });
}

export async function validateTarget(inputUrl: string, runtime: TrafficRuntime = {}): Promise<string> {
  const url = safeRequestUrl(inputUrl);
  if (!url || !["http:", "https:"].includes(new URL(url).protocol)) throw new Error("Enter a valid public HTTP or HTTPS website URL.");
  if (!(await (runtime.isPublicHostname ?? isPublicHostname)(new URL(url).hostname))) throw new Error("Only public internet hosts can be analyzed.");
  return url;
}

export async function analyzeTraffic(inputUrl: string, captureDurationSeconds = 8, runtime: TrafficRuntime = {}): Promise<TrafficAnalysis> {
  const url = await validateTarget(inputUrl, runtime);
  const started = performance.now();
  const capturedAt = new Date().toISOString();
  const requests: CapturedRequest[] = [];
  const warnings: string[] = [];
  let blockedCount = 0;
  const browser = await (runtime.launchBrowser ?? launchCaptureBrowser)();
  try {
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    const page = await context.newPage();
    const capture = attachCaptureListeners(page, requests);
    await capture.ready;
    await installSafeRouting(context, () => blockedCount += 1, runtime);
    page.on("dialog", dialog => { void dialog.dismiss(); });
    context.on("page", popup => { if (popup !== page) void popup.close(); });
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
      if (response && [401, 403, 429].includes(response.status())) warnings.push(`Zugriffsschutz oder Begrenzung (HTTP ${response.status()}). Keine Umgehung versucht.`);
    } catch {
      warnings.push("Die Seite wurde nicht vollständig geladen. Angezeigt werden nur tatsächlich beobachtete Requests.");
    }
    await page.waitForTimeout(captureDurationSeconds * 1000);
    await capture.drain();
    const snapshot = capture.snapshot();
    capture.dispose();
    if (snapshot.length >= MAX_RECORDED_REQUESTS) warnings.push("Erfassungslimit von 300 Requests erreicht.");
    return { url: sanitizeUrl(url), capturedAt, durationMs: Math.round((performance.now() - started) * 10) / 10, requestCount: snapshot.length, blockedCount, counts: countsFor(snapshot), requests: snapshot, warnings };
  } finally { await browser.close(); }
}
