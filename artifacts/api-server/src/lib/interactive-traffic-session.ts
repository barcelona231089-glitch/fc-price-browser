import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import {
  attachCaptureListeners,
  installSafeRouting,
  launchCaptureBrowser,
  validateTarget,
  type TrafficRuntime,
  type CaptureController,
  sanitizeUrl,
  type CapturedRequest,
} from "./traffic-analyzer";

const MAX_SESSIONS = 2;
const SESSION_IDLE_LIMIT_MS = 3 * 60_000;
const SESSION_LIFETIME_LIMIT_MS = 30 * 60_000;
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;
let sessionStartsInProgress = 0;

type InteractiveSession = {
  id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  url: string;
  startedAt: string;
  startedAtMs: number;
  startedPerformanceMs: number;
  lastActivityMs: number;
  recording: boolean;
  requests: CapturedRequest[];
  blockedCount: number;
  capture: CaptureController;
  warnings: string[];
  jsonDocument: boolean;
  operationQueue: Promise<void>;
};

export type InteractiveSessionState = {
  sessionId: string;
  url: string;
  startedAt: string;
  recording: boolean;
  closed: boolean;
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
  screenshot: string | null;
  viewportWidth: number;
  viewportHeight: number;
  warnings: string[];
};

const sessions = new Map<string, InteractiveSession>();
import { countsFor } from "@workspace/traffic-core";

function safeDisplayUrl(rawUrl: string, fallback: string): string {
  try {
    return sanitizeUrl(rawUrl);
  } catch {
    return fallback;
  }
}

function sessionById(sessionId: string): InteractiveSession | null {
  return sessions.get(sessionId) ?? null;
}

function enqueueInteraction(
  session: InteractiveSession,
  operation: () => Promise<void>,
): Promise<void> {
  const nextOperation = session.operationQueue.then(operation, operation);
  session.operationQueue = nextOperation.catch(() => undefined);
  return nextOperation;
}

async function closeSessionResources(session: InteractiveSession): Promise<void> {
  sessions.delete(session.id);
  session.capture.dispose();
  session.requests.length = 0;
  try {
    await session.context.close();
  } catch {
    // The browser context may already be closed.
  }
  try {
    await session.browser.close();
  } catch {
    // The browser may already be closed.
  }
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (
      now - session.lastActivityMs > SESSION_IDLE_LIMIT_MS ||
      now - session.startedAtMs > SESSION_LIFETIME_LIMIT_MS
    ) {
      void closeSessionResources(session);
    }
  }
}, 30_000);
cleanupTimer.unref?.();

export async function startInteractiveTrafficSession(
  inputUrl: string,
  runtime: TrafficRuntime = {},
): Promise<InteractiveSessionState> {
  if (sessions.size + sessionStartsInProgress >= MAX_SESSIONS) {
    throw new Error("The interactive session limit has been reached.");
  }
  sessionStartsInProgress += 1;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let session: InteractiveSession | null = null;
  try {
    const safeUrl = await validateTarget(inputUrl, runtime);
    browser = await (runtime.launchBrowser ?? launchCaptureBrowser)();
    context = await browser.newContext({
      viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    const page = await context.newPage();
    const now = Date.now();
    const requests: CapturedRequest[] = [];
    const capture = attachCaptureListeners(page, requests, () => createdSession.recording);
    const createdSession: InteractiveSession = {
      id: randomUUID(),
      browser,
      context,
      page,
      url: sanitizeUrl(safeUrl),
      startedAt: new Date(now).toISOString(),
      startedAtMs: now,
      startedPerformanceMs: performance.now(),
      lastActivityMs: now,
      recording: true,
      requests,
      capture,
      warnings: [],
      jsonDocument: false,
      blockedCount: 0,
      operationQueue: Promise.resolve(),
    };
    session = createdSession;
    sessions.set(createdSession.id, createdSession);

    await capture.ready;
    page.on("response", (response) => {
      if (response.request().isNavigationRequest() && response.request().frame() === page.mainFrame()) {
        const contentType = response.headers()["content-type"] ?? "";
        createdSession.jsonDocument = /application\/(?:json|graphql)|\+json/.test(contentType);
        if ([401, 403, 429].includes(response.status())) {
          createdSession.warnings = [`Zugriffsschutz oder Begrenzung (HTTP ${response.status()}). Keine Umgehung versucht.`];
        }
      }
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        createdSession.url = safeDisplayUrl(frame.url(), createdSession.url);
      }
    });
    page.on("dialog", (dialog) => {
      void dialog.dismiss();
    });
    context.on("page", (newPage) => {
      if (newPage !== page) void newPage.close();
    });
    await installSafeRouting(context, () => createdSession.blockedCount += 1, runtime);

    try {
      await page.goto(safeUrl, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
    } catch {
      createdSession.warnings.push("Die Seite wurde nicht vollständig geladen. Nur tatsächlich beobachtete Requests werden angezeigt.");
    }

    const state = await getInteractiveTrafficSessionState(createdSession.id);
    if (!state) throw new Error("The interactive browser session could not be started.");
    return state;
  } catch (error) {
    if (context) {
      try {
        await context.close();
      } catch {
        // Cleanup still continues by closing the browser below.
      }
    }
    if (session) sessions.delete(session.id);
    if (browser) {
      try {
        await browser.close();
      } catch {
        // The browser may already be closed.
      }
    }
    if (
      error instanceof Error &&
      [
        "The interactive session limit has been reached.",
        "Enter a valid public HTTP or HTTPS website URL.",
        "Only public internet hosts can be analyzed.",
      ].includes(error.message)
    ) {
      throw error;
    }
    throw new Error("The interactive browser session could not be started.");
  } finally {
    sessionStartsInProgress -= 1;
  }
}

export async function getInteractiveTrafficSessionState(
  sessionId: string,
): Promise<InteractiveSessionState | null> {
  const session = sessionById(sessionId);
  if (!session) return null;
  session.lastActivityMs = Date.now();

  await session.capture.drain(500);
  let screenshot: string | null = null;
  if (!session.page.isClosed()) {
    try {
      const bytes = await session.page.screenshot({
        type: "jpeg",
        quality: 48,
        animations: "disabled",
        timeout: 5_000,
        mask: session.jsonDocument ? [session.page.locator("body")] : session.page.frames().map(frame => frame.locator(
          'input[type="password"], input[autocomplete*="password" i], input[autocomplete*="token" i], input[name*="password" i], input[id*="password" i], input[name*="passcode" i], input[name*="token" i], input[id*="token" i], input[name*="secret" i], input[id*="secret" i], input[name*="api" i], input[id*="api" i], input[name*="auth" i], input[id*="auth" i], input[name*="credential" i], textarea, pre, code, [data-secret], [data-token], [id*="secret" i], [id*="token" i], [class*="secret" i], [class*="token" i]',
        )),
        maskColor: "#25322d",
      });
      screenshot = bytes.toString("base64");
    } catch {
      screenshot = null;
    }
  }

  const now = performance.now();
  return {
    sessionId: session.id,
    url: session.url,
    startedAt: session.startedAt,
    recording: session.recording,
    closed: session.page.isClosed(),
    durationMs: Math.max(0, Math.round((now - session.startedPerformanceMs) * 10) / 10),
    requestCount: session.requests.length,
    blockedCount: session.blockedCount,
    counts: countsFor(session.requests),
    warnings: [...session.warnings],
    requests: session.capture.snapshot(),
    screenshot,
    viewportWidth: VIEWPORT_WIDTH,
    viewportHeight: VIEWPORT_HEIGHT,
  };
}

export async function setInteractiveTrafficRecording(
  sessionId: string,
  recording: boolean,
  reset = false,
): Promise<InteractiveSessionState | null> {
  const session = sessionById(sessionId);
  if (!session) return null;
  await enqueueInteraction(session, async () => {
    if (reset) session.capture.reset();
    session.recording = recording;
  });
  session.lastActivityMs = Date.now();
  return getInteractiveTrafficSessionState(sessionId);
}

function isAllowedKey(key: string): boolean {
  return key.length === 1 || /^(?:Control\+[af]|Shift\+(?:Tab|.)|Space|Enter|Tab|Escape|Backspace|Delete|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/i.test(key);
}

function isClipboardShortcut(key: string): boolean {
  return /^(?:(?:Control|Meta)\+)+(?:c|v|x|insert|shift\+insert)$/i.test(key);
}

async function sensitiveFieldFocused(page: Page): Promise<boolean> {
  try {
    for (const frame of page.frames()) {
      const focused = await frame.evaluate(() => {
      type FocusedElement = {
        type?: string;
        getAttribute: (name: string) => string | null;
      };
      const browserDocument = (
        globalThis as unknown as {
          document?: { activeElement?: FocusedElement | null };
        }
      ).document;
      const active = browserDocument?.activeElement;
      if (!active) return false;
      if (active.type?.toLowerCase() === "password") {
        return true;
      }
      const fieldData = [
        active.getAttribute("name"),
        active.getAttribute("id"),
        active.getAttribute("autocomplete"),
        active.getAttribute("aria-label"),
        active.getAttribute("placeholder"),
      ]
        .filter(Boolean)
        .join(" ");
      return /password|passwd|passcode|pwd|token|secret|credential|auth|cookie|api[-_ ]?key|captcha/i.test(
        fieldData,
      );
      });
      if (focused) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export async function interactWithInteractiveTrafficSession(input: {
  sessionId: string;
  action: "click" | "scroll" | "key";
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  key?: string;
}): Promise<{ ok: boolean } | null> {
  const session = sessionById(input.sessionId);
  if (!session || session.page.isClosed()) return null;
  session.lastActivityMs = Date.now();

  await enqueueInteraction(session, async () => {
    if (input.action === "click") {
      if (input.x == null || input.y == null) {
        throw new Error("A click needs a screen position.");
      }
      await session.page.mouse.click(input.x, input.y);
      return;
    }
    if (input.action === "scroll") {
      await session.page.mouse.wheel(input.deltaX ?? 0, input.deltaY ?? 0);
      return;
    }

    const key = input.key ?? "";
    if (isClipboardShortcut(key)) {
      throw new Error("Clipboard shortcuts are disabled in the remote session.");
    }
    if (!isAllowedKey(key)) throw new Error("This key is not available.");
    if (
      !/^(?:Tab|Shift\+Tab|Escape|Backspace|Delete|Arrow(?:Up|Down|Left|Right))$/i.test(key) &&
      (await sensitiveFieldFocused(session.page))
    ) {
      throw new Error("Text entry in password and token fields is blocked.");
    }
    await session.page.keyboard.press(key);
  });

  return { ok: true };
}

export async function endInteractiveTrafficSession(
  sessionId: string,
): Promise<{ ok: boolean } | null> {
  const session = sessionById(sessionId);
  if (!session) return null;
  await closeSessionResources(session);
  return { ok: true };
}
export async function closeAllInteractiveTrafficSessions(): Promise<void> {
  await Promise.allSettled([...sessions.values()].map(closeSessionResources));
}
