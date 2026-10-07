import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"] ?? "5174";

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, process.env.HOST ?? (process.env.REPL_ID ? "0.0.0.0" : "127.0.0.1"), (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

import { closeAllInteractiveTrafficSessions } from "./lib/interactive-traffic-session";
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    server.close();
    await closeAllInteractiveTrafficSessions();
    process.exit(0);
  });
}
