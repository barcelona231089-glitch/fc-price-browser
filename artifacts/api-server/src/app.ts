import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import healthRouter from "./routes/health";
import { createTrafficRouter } from "./routes/traffic";
import type { TrafficRuntime } from "./lib/traffic-analyzer";
import { logger } from "./lib/logger";

export function createApp(runtime: TrafficRuntime = {}): Express {
const app: Express = express();
app.disable("x-powered-by");
app.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: /^\/api\/(?:healthz|traffic\/(?:analyze|session\/(?:start|state|recording|interact|end)))$/.test(req.url?.split("?")[0] ?? "") ? req.url.split("?")[0] : "/[unknown]",
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (!origin) { next(); return; }
  const localOrigins = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5174", "http://127.0.0.1:5174"];
  const configured = (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean);
  let sameOrigin = false;
  try {
    const url = new URL(origin);
    const forwarded = (req.ip === "127.0.0.1" || req.ip === "::ffff:127.0.0.1") ? req.get("x-forwarded-host") : undefined;
    sameOrigin = ["http:", "https:"].includes(url.protocol) && (url.host === req.get("host") || url.host === forwarded);
  } catch { /* Invalid origin remains blocked. */ }
  if (!sameOrigin && !localOrigins.includes(origin) && !configured.includes(origin)) {
    res.status(403).json({ error: "This browser origin is not allowed." });
    return;
  }
  cors({ origin, methods: ["GET", "POST", "OPTIONS"] })(req, res, next);
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", healthRouter, createTrafficRouter(runtime));
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error instanceof SyntaxError ? 400 : 500).json({ error: "The request could not be processed." });
});
return app;
}

export default createApp();
