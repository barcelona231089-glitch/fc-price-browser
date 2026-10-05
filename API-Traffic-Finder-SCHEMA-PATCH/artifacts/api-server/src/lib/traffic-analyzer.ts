import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import { chromium, type Page, type Request, type WebSocket } from "playwright";

const MAX_RECORDED_REQUESTS = 300;
const MAX_PAGE_REQUESTS = 500;
const DEFAULT_CAPTURE_SECONDS = 6;
const NAVIGATION_TIMEOUT_MS = 12_000;
const SECRET_PATH_MARKER =
  /^(?:access[-_]?token|api[-_]?key|auth(?:orization)?|credential|password|secret|session|signature|sig|token|code)$/i;

type RequestType = "fetch-xhr" | "rest" | "graphql" | "websocket";

export type CapturedRequest = {
  id: string;
  url: string;
  hostname: string;
  path: string;
  method: string;
  statusCode: number | null;
  contentType: string | null;
  startedAt: string;
  durationMs: number | null;
  type: RequestType;
  resourceType: string;
  responseSchema: string[] | null;
  startedAtMs: number;
};

export type TrafficAnalysis = {
  url: string;
  capturedAt: string;
  durationMs: number;
  requestCount: number;
  blockedCount: number;
  counts: {
    fetchXhr: number;
    rest: number;
    graphql: number;
    websocket: number;
  };
  requests: Array<Omit<CapturedRequest, "startedAtMs">>;
};

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => part < 0 || part > 255)) {
    return true;
  }
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  ) {
    return true;
  }

  const mappedIpv4 = normalized.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return mappedIpv4 ? isPrivateIpv4(mappedIpv4[1]) : false;
}

function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !isPrivateIpv4(address);
  if (version === 6) return !isPrivateIpv6(address);
  return false;
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export async function isPublicHostname(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".test")
  ) {
    return false;
  }

  if (isIP(host)) return isPublicAddress(host);

  try {
    const results = await lookup(host, { all: true, verbatim: true });
    return results.length > 0 && results.every((entry) => isPublicAddress(entry.address));
  } catch {
    return false;
  }
}

function hasSensitivePath(url: URL): boolean {
  return url.pathname
    .split("/")
    .some((segment) => SECRET_PATH_MARKER.test(decodePathSegment(segment)));
}

export function safeRequestUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return null;
  if (parsed.username || parsed.password || hasSensitivePath(parsed)) return null;

  // Keep the user-supplied query string for the actual navigation so pages
  // that depend on it still work. Query strings are never exposed in results:
  // sanitizeUrl() strips them before any request metadata leaves the server.
  parsed.hash = "";
  return parsed.toString();
}

export function safeOutboundRequestUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return null;
  if (parsed.username || parsed.password) return null;

  // Keep query strings on browser-generated subrequests so public sites keep
  // functioning normally. They are still stripped from every captured result
  // by sanitizeUrl(), and fragments are never sent over HTTP anyway.
  parsed.hash = "";
  return parsed.toString();
}

function redactPath(pathname: string): string {
  const segments = pathname.split("/");
  return segments
    .map((segment, index) => {
      const decoded = decodePathSegment(segment);
      const previous = index > 0 ? decodePathSegment(segments[index - 1]) : "";
      if (SECRET_PATH_MARKER.test(previous)) return "[redacted]";
      if (
        decoded.length >= 28 &&
        /^[A-Za-z0-9._~-]+$/.test(decoded) &&
        /[A-Z]/.test(decoded) &&
        /[a-z]/.test(decoded) &&
        /\d/.test(decoded)
      ) {
        return "[redacted]";
      }
      return segment;
    })
    .join("/");
}

export function sanitizeUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  parsed.search = "";
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  return `${parsed.origin}${redactPath(parsed.pathname)}`;
}

function safeContentType(value: string | null): string | null {
  if (!value) return null;
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)
    ? mediaType
    : null;
}

function jsonSchemaPaths(value: unknown, prefix = "", depth = 0): string[] {
  if (depth > 3 || value === null || typeof value !== "object") return [];
  const sample = Array.isArray(value) ? value.slice(0, 3) : [value];
  const paths = new Set<string>();
  for (const item of sample) {
    if (item === null || typeof item !== "object") continue;
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (SECRET_PATH_MARKER.test(key)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      paths.add(path);
      for (const nested of jsonSchemaPaths(child, path, depth + 1)) paths.add(nested);
      if (paths.size >= 80) break;
    }
    if (paths.size >= 80) break;
  }
  return [...paths].slice(0, 80);
}

function inferType(pathname: string, contentType: string | null): RequestType {
  if (/\/(?:graphql|gql)(?:\/|$)/i.test(pathname)) return "graphql";
  if (contentType?.startsWith("application/graphql")) return "graphql";
  if (
    /(?:^|\/)(?:api|rest)(?:\/|$)|\/v\d+(?:\/|$)/i.test(pathname) ||
    contentType === "application/json" ||
    contentType?.endsWith("+json")
  ) {
    return "rest";
  }
  return "fetch-xhr";
}

export function browserExecutablePath(): string {
  const requestedPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const candidates = [
    requestedPath,
    "/repl/tools/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    chromium.executablePath(),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executablePath = candidates.find((candidate) => existsSync(candidate));
  if (!executablePath) {
    throw new Error("A Chromium executable is not available in this environment.");
  }
  return executablePath;
}

export function attachCaptureListeners(
  page: Page,
  requests: CapturedRequest[],
  isRecording: () => boolean = () => true,
): void {
  const requestsByHandle = new WeakMap<Request, CapturedRequest>();
  const deferredNavigations = new WeakSet<CapturedRequest>();
  const websocketRequests = new Map<string, CapturedRequest>();
  let nextId = 1;

  const addRequest = (
    url: string,
    method: string,
    resourceType: string,
    startedAtMs: number,
    deferUntilJsonResponse = false,
  ): CapturedRequest | null => {
    if (!isRecording() || requests.length >= MAX_RECORDED_REQUESTS) return null;
    let safeUrl: string;
    let parsed: URL;
    try {
      safeUrl = sanitizeUrl(url);
      parsed = new URL(safeUrl);
    } catch {
      return null;
    }

    const record: CapturedRequest = {
      id: `request-${nextId++}`,
      url: safeUrl,
      hostname: parsed.hostname,
      path: parsed.pathname,
      method,
      statusCode: null,
      contentType: null,
      startedAt: new Date().toISOString(),
      durationMs: null,
      type: resourceType === "websocket" ? "websocket" : "fetch-xhr",
      resourceType,
      responseSchema: null,
      startedAtMs,
    };
    if (record.type !== "websocket") {
      record.type = inferType(parsed.pathname, null);
    }
    if (deferUntilJsonResponse) deferredNavigations.add(record);
    else requests.push(record);
    return record;
  };

  page.on("request", (request) => {
    const resourceType = request.resourceType();
    const isFetchXhr = resourceType === "fetch" || resourceType === "xhr";
    const isWebSocket = resourceType === "websocket";
    const isNavigation = resourceType === "document" && request.isNavigationRequest();
    if (!isFetchXhr && !isNavigation && !isWebSocket) return;
    const record = addRequest(
      request.url(),
      request.method(),
      resourceType,
      performance.now(),
      isNavigation,
    );
    if (!record) return;
    requestsByHandle.set(request, record);
    if (isWebSocket) websocketRequests.set(record.url, record);
  });

  page.on("response", async (response) => {
    const request = response.request();
    const record = requestsByHandle.get(request);
    if (!record) return;
    record.statusCode = response.status();
    try {
      record.contentType = safeContentType(
        await response.headerValue("content-type"),
      );
    } catch {
      record.contentType = null;
    }
    if (record.type !== "websocket") {
      record.type = inferType(new URL(record.url).pathname, record.contentType);
    }
    const isJson =
      record.contentType === "application/json" ||
      record.contentType?.endsWith("+json");
    if (isJson) {
      try {
        const contentLength = Number(await response.headerValue("content-length") ?? "0");
        if (!contentLength || contentLength <= 262_144) {
          const parsedBody = JSON.parse(await response.text());
          const schema = jsonSchemaPaths(parsedBody);
          record.responseSchema = schema.length ? schema : null;
        }
      } catch {
        record.responseSchema = null;
      }
    }
    if (deferredNavigations.has(record)) {
      if (
        record.contentType === "application/json" ||
        record.contentType?.endsWith("+json")
      ) {
        record.type = inferType(new URL(record.url).pathname, record.contentType);
        if (record.type !== "fetch-xhr") record.resourceType = "document";
        requests.push(record);
      } else {
        requestsByHandle.delete(request);
      }
    }
  });

  const finishRequest = (request: Request): void => {
    const record = requestsByHandle.get(request);
    if (!record) return;
    record.durationMs = Math.max(
      0,
      Math.round((performance.now() - record.startedAtMs) * 10) / 10,
    );
  };

  page.on("requestfinished", finishRequest);
  page.on("requestfailed", finishRequest);

  page.on("websocket", (socket) => {
    const startedAtMs = performance.now();
    let socketUrl: string;
    try {
      socketUrl = sanitizeUrl(socket.url());
    } catch {
      return;
    }
    const record =
      websocketRequests.get(socketUrl) ??
      addRequest(socketUrl, "GET", "websocket", startedAtMs);
    if (!record) return;
    websocketRequests.delete(socketUrl);
    socket.on("close", () => {
      record.durationMs = Math.max(
        0,
        Math.round((performance.now() - record.startedAtMs) * 10) / 10,
      );
    });
  });
}

export async function analyzeTraffic(
  inputUrl: string,
  captureDurationSeconds = DEFAULT_CAPTURE_SECONDS,
): Promise<TrafficAnalysis> {
  const networkUrl = safeRequestUrl(inputUrl);
  if (!networkUrl) {
    throw new Error("Enter a valid public HTTP or HTTPS website URL.");
  }

  const target = new URL(networkUrl);
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("Only public HTTP and HTTPS websites can be analyzed.");
  }
  if (!(await isPublicHostname(target.hostname))) {
    throw new Error("Only public internet hosts can be analyzed.");
  }

  const startedAtMs = performance.now();
  const capturedAt = new Date().toISOString();
  const requests: CapturedRequest[] = [];
  let blockedCount = 0;
  let pageRequestCount = 0;
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutablePath(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const context = await browser.newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    const page = await context.newPage();
    attachCaptureListeners(page, requests);

    await context.route("**/*", async (route) => {
      try {
        const request = route.request();
        const safeUrl = safeOutboundRequestUrl(request.url());
        if (!safeUrl || !(await isPublicHostname(new URL(safeUrl).hostname))) {
          blockedCount += 1;
          await route.abort("blockedbyclient");
          return;
        }

        pageRequestCount += 1;
        if (pageRequestCount > MAX_PAGE_REQUESTS) {
          blockedCount += 1;
          await route.abort("blockedbyclient");
          return;
        }

        const headers = await request.allHeaders();
        for (const name of Object.keys(headers)) {
          if (
            /(?:authorization|cookie|token|api[-_]?key|secret|password|credential|session)/i.test(
              name,
            )
          ) {
            delete headers[name];
          }
        }
        await route.continue({ url: safeUrl, headers });
      } catch {
        blockedCount += 1;
        try {
          await route.abort("blockedbyclient");
        } catch {
          // The browser may have already canceled the route.
        }
      }
    });

    try {
      await page.goto(networkUrl, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
    } catch {
      // A partial capture is still useful when the document itself times out.
    }

    await page.waitForTimeout(captureDurationSeconds * 1000);

    const endedAtMs = performance.now();
    for (const request of requests) {
      if (request.type === "websocket" && request.durationMs === null) {
        request.durationMs = Math.max(
          0,
          Math.round((endedAtMs - request.startedAtMs) * 10) / 10,
        );
      }
    }

    const counts = {
      fetchXhr: requests.filter((request) =>
        ["fetch", "xhr"].includes(request.resourceType),
      ).length,
      rest: requests.filter((request) => request.type === "rest").length,
      graphql: requests.filter((request) => request.type === "graphql").length,
      websocket: requests.filter((request) => request.type === "websocket").length,
    };

    return {
      url: sanitizeUrl(networkUrl),
      capturedAt,
      durationMs: Math.round((endedAtMs - startedAtMs) * 10) / 10,
      requestCount: requests.length,
      blockedCount,
      counts,
      requests: requests.map(({ startedAtMs: _startedAtMs, ...request }) => request),
    };
  } finally {
    await browser.close();
  }
}