import {
  AnalyzeTrafficBody,
  AnalyzeTrafficResponse,
  EndTrafficSessionBody,
  EndTrafficSessionResponse,
  GetTrafficSessionStateQueryParams,
  GetTrafficSessionStateResponse,
  InteractWithTrafficSessionBody,
  InteractWithTrafficSessionResponse,
  SetTrafficSessionRecordingBody,
  SetTrafficSessionRecordingResponse,
  StartTrafficSessionBody,
  StartTrafficSessionResponse,
} from "@workspace/api-zod";
import { Router, type IRouter } from "express";
import {
  endInteractiveTrafficSession,
  getInteractiveTrafficSessionState,
  interactWithInteractiveTrafficSession,
  setInteractiveTrafficRecording,
  startInteractiveTrafficSession,
} from "../lib/interactive-traffic-session";
import { analyzeTraffic, type TrafficRuntime } from "../lib/traffic-analyzer";

export function createTrafficRouter(runtime: TrafficRuntime = {}): IRouter {
const router: IRouter = Router();
const RATE_WINDOW_MS = 60_000;
const REQUESTS_PER_WINDOW = 6;
const MAX_CONCURRENT_ANALYSES = 2;
const recentAnalyses = new Map<string, number[]>();
let activeAnalyses = 0;

function consumeAnalysisAllowance(clientKey: string, now: number): boolean {
  const recent = (recentAnalyses.get(clientKey) ?? []).filter(
    (timestamp) => now - timestamp < RATE_WINDOW_MS,
  );
  if (recent.length >= REQUESTS_PER_WINDOW) return false;
  recentAnalyses.set(clientKey, [...recent, now]);
  return true;
}

router.post("/traffic/analyze", async (req, res): Promise<void> => {
  const parsed = AnalyzeTrafficBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Enter a valid public website URL and confirm you are authorized to analyze it.",
    });
    return;
  }

  if (!parsed.data.authorized) {
    res.status(400).json({
      error: "Confirm that you are authorized to analyze this website.",
    });
    return;
  }

  if (!consumeAnalysisAllowance(req.ip ?? "unknown", Date.now())) {
    res.status(429).json({
      error: "Analysis limit reached. Please wait a minute before trying again.",
    });
    return;
  }
  if (activeAnalyses >= MAX_CONCURRENT_ANALYSES) {
    res.status(429).json({
      error: "The analyzer is busy. Please try again shortly.",
    });
    return;
  }

  activeAnalyses += 1;

  try {
    const result = await analyzeTraffic(
      parsed.data.url,
      parsed.data.captureDurationSeconds,
      runtime,
    );
    const validated = AnalyzeTrafficResponse.safeParse(result);
    if (!validated.success) {
      req.log.error(
        { issuePaths: validated.error.issues.map((issue) => issue.path) },
        "Traffic analysis response did not match its contract",
      );
      res.status(500).json({ error: "The analysis result could not be prepared." });
      return;
    }
    res.json(validated.data);
  } catch (error) {
    const message =
      error instanceof Error &&
      (error.message === "Enter a valid public HTTP or HTTPS website URL." ||
        error.message === "Only public HTTP and HTTPS websites can be analyzed." ||
        error.message === "Only public internet hosts can be analyzed.")
        ? error.message
        : "The website could not be analyzed. Check that it is publicly reachable and try again.";
    req.log.warn({ failure: "traffic_analysis_failed" }, "Traffic analysis failed");
    res.status(message === "Only public internet hosts can be analyzed." || message === "Enter a valid public HTTP or HTTPS website URL." || message === "Only public HTTP and HTTPS websites can be analyzed." ? 400 : 502).json({ error: message });
  } finally {
    activeAnalyses -= 1;
  }
});

router.post("/traffic/session/start", async (req, res): Promise<void> => {
  const parsed = StartTrafficSessionBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.authorized) {
    res.status(400).json({
      error: "Enter a valid public website URL and confirm you are authorized to analyze it.",
    });
    return;
  }

  if (!consumeAnalysisAllowance(req.ip ?? "unknown", Date.now())) {
    res.status(429).json({
      error: "Session start limit reached. Please wait a minute before trying again.",
    });
    return;
  }

  try {
    const state = await startInteractiveTrafficSession(parsed.data.url, runtime);
    const validated = StartTrafficSessionResponse.safeParse(state);
    if (!validated.success) {
      await endInteractiveTrafficSession(state.sessionId);
      req.log.error(
        { issuePaths: validated.error.issues.map((issue) => issue.path) },
        "Interactive session response did not match its contract",
      );
      res.status(500).json({ error: "The browser session could not be prepared." });
      return;
    }
    res.status(201).json(validated.data);
  } catch (error) {
    const limitReached =
      error instanceof Error &&
      error.message === "The interactive session limit has been reached.";
    const publicTargetError =
      error instanceof Error &&
      (error.message === "Enter a valid public HTTP or HTTPS website URL." ||
        error.message === "Only public internet hosts can be analyzed.");
    req.log.warn(
      { failure: "interactive_session_start_failed" },
      "Interactive browser session could not be started",
    );
    res.status(limitReached ? 429 : publicTargetError ? 400 : 502).json({
      error: limitReached
        ? "The interactive browser is busy. End another session and try again."
        : publicTargetError
          ? error.message
          : "The public website could not be opened in an interactive session.",
    });
  }
});

router.get("/traffic/session/state", async (req, res): Promise<void> => {
  const parsed = GetTrafficSessionStateQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "The interactive session is invalid or expired." });
    return;
  }

  const state = await getInteractiveTrafficSessionState(parsed.data.sessionId);
  if (!state) {
    res.status(404).json({ error: "The interactive session has ended or expired." });
    return;
  }

  const validated = GetTrafficSessionStateResponse.safeParse(state);
  if (!validated.success) {
    req.log.error(
      { issuePaths: validated.error.issues.map((issue) => issue.path) },
      "Interactive session state did not match its contract",
    );
    res.status(500).json({ error: "The interactive session state could not be prepared." });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(validated.data);
});

router.post("/traffic/session/recording", async (req, res): Promise<void> => {
  const parsed = SetTrafficSessionRecordingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "The recording setting is invalid." });
    return;
  }

  const state = await setInteractiveTrafficRecording(
    parsed.data.sessionId,
    parsed.data.recording,
    parsed.data.reset,
  );
  if (!state) {
    res.status(404).json({ error: "The interactive session has ended or expired." });
    return;
  }

  const validated = SetTrafficSessionRecordingResponse.safeParse(state);
  if (!validated.success) {
    req.log.error(
      { issuePaths: validated.error.issues.map((issue) => issue.path) },
      "Recording state did not match its contract",
    );
    res.status(500).json({ error: "The recording state could not be prepared." });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(validated.data);
});

router.post("/traffic/session/interact", async (req, res): Promise<void> => {
  const parsed = InteractWithTrafficSessionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "The browser interaction is invalid." });
    return;
  }

  try {
    const result = await interactWithInteractiveTrafficSession(parsed.data);
    if (!result) {
      res.status(404).json({ error: "The interactive session has ended or expired." });
      return;
    }
    res.json(InteractWithTrafficSessionResponse.parse(result));
  } catch (error) {
    const safeMessages = [
      "A click needs a screen position.",
      "This key is not available.",
      "Clipboard shortcuts are disabled in the remote session.",
      "Text entry in password and token fields is blocked.",
    ];
    res.status(400).json({
      error:
        error instanceof Error && safeMessages.includes(error.message)
          ? error.message
          : "The browser interaction could not be completed.",
    });
  }
});

router.post("/traffic/session/end", async (req, res): Promise<void> => {
  const parsed = EndTrafficSessionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "The interactive session is invalid." });
    return;
  }
  const result = await endInteractiveTrafficSession(parsed.data.sessionId);
  if (!result) {
    res.status(404).json({ error: "The interactive session has ended or expired." });
    return;
  }
  res.json(EndTrafficSessionResponse.parse(result));
});

return router;
}

export default createTrafficRouter();