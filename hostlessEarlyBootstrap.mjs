import http from "node:http";
import { spawn } from "node:child_process";

const prefix = "[hostless-early-bootstrap-v3]";
const externalPort = Number(process.env.PORT || 3000);
const configuredInternalPort = Number(process.env.HOSTLESS_INTERNAL_PORT || 0);
const internalPort = configuredInternalPort > 0
  ? configuredInternalPort
  : (externalPort >= 65534 ? externalPort - 1 : externalPort + 1);

let upstreamReady = false;
let child = null;
let shuttingDown = false;
let restartTimer = null;
let nextRestartAt = null;
let totalChildRestarts = 0;
let consecutiveChildFailures = 0;
let lastChildExitAt = null;
let lastChildExitCode = null;
let lastChildExitSignal = null;

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store"
  });
  res.end(payload);
}

function bootstrapStatus() {
  const restarting = Boolean(restartTimer);
  return {
    ok: true,
    service: "fc-trader-brain",
    readiness: upstreamReady ? "ready" : (restarting ? "brain-restarting" : "booting"),
    bootstrap: "early-port-v3-supervisor",
    buildMarker: "sales-evidence-v1",
    brainReady: upstreamReady,
    externalPort,
    internalPort,
    childPid: child?.pid || null,
    childRestarts: totalChildRestarts,
    consecutiveChildFailures,
    lastChildExitAt,
    lastChildExitCode,
    lastChildExitSignal,
    nextRestartAt
  };
}

function proxyToBrain(req, res) {
  const headers = { ...req.headers };
  headers.host = `127.0.0.1:${internalPort}`;
  headers["x-forwarded-host"] = req.headers.host || "";
  headers["x-forwarded-proto"] = "https";

  const proxy = http.request(
    {
      host: "127.0.0.1",
      port: internalPort,
      method: req.method,
      path: req.url,
      headers
    },
    upstream => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    }
  );

  proxy.on("error", error => {
    console.error(`${prefix} proxy error: ${error?.message || error}`);
    upstreamReady = false;
    if (!res.headersSent) {
      json(res, 502, {
        ok: false,
        service: "fc-trader-brain",
        error: "UPSTREAM_UNAVAILABLE"
      });
    } else {
      res.destroy(error);
    }
  });

  req.pipe(proxy);
}

function requestPath(url = "/") {
  return String(url).split("?", 1)[0];
}

function isBootstrapProbe(path) {
  return path === "/" || path === "/health" || path === "/api/readiness";
}

const bootstrapServer = http.createServer((req, res) => {
  const path = requestPath(req.url);

  if (path === "/healthz" || path === "/bootstrap-status") {
    return json(res, 200, bootstrapStatus());
  }

  if (!upstreamReady) {
    if (isBootstrapProbe(path)) {
      return json(res, 200, bootstrapStatus());
    }

    return json(res, 503, {
      ok: false,
      service: "fc-trader-brain",
      readiness: restartTimer ? "brain-restarting" : "booting"
    });
  }

  return proxyToBrain(req, res);
});

bootstrapServer.on("clientError", (error, socket) => {
  console.error(`${prefix} client error: ${error?.message || error}`);
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

function probeUpstream() {
  return new Promise(resolve => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port: internalPort,
        path: "/healthz",
        timeout: 1500
      },
      res => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );

    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function waitForUpstream(childRef) {
  while (!shuttingDown && child === childRef && childRef.exitCode == null) {
    if (await probeUpstream()) {
      upstreamReady = true;
      consecutiveChildFailures = 0;
      nextRestartAt = null;
      console.log(`${prefix} full brain ready on internal port ${internalPort}; proxy enabled.`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

function restartDelayMs() {
  const power = Math.min(consecutiveChildFailures, 4);
  return Math.min(30_000, 1500 * (2 ** power));
}

function scheduleBrainRestart(reason) {
  if (shuttingDown || restartTimer) return;

  upstreamReady = false;
  consecutiveChildFailures += 1;
  const delayMs = restartDelayMs();
  nextRestartAt = new Date(Date.now() + delayMs).toISOString();

  console.error(
    `${prefix} scheduling full brain restart in ${delayMs}ms after ${reason}; consecutiveFailures=${consecutiveChildFailures}.`
  );

  restartTimer = setTimeout(() => {
    restartTimer = null;
    nextRestartAt = null;
    totalChildRestarts += 1;
    startBrainChild();
  }, delayMs);
  restartTimer.unref?.();
}

function startBrainChild() {
  if (shuttingDown) return;
  if (child && child.exitCode == null) return;

  const childEnv = {
    ...process.env,
    PORT: String(internalPort),
    HOSTLESS_PARENT_PORT: String(externalPort),
    HOSTLESS_EARLY_BOOTSTRAP_CHILD: "1",
    NODE_OPTIONS: process.env.HOSTLESS_BRAIN_NODE_OPTIONS || process.env.NODE_OPTIONS || "--max-old-space-size=320"
  };

  const childRef = spawn(
    process.execPath,
    ["./v1069965LeakHotfixL7Bootstrap.mjs"],
    {
      cwd: process.cwd(),
      env: childEnv,
      stdio: "inherit",
      windowsHide: true
    }
  );
  child = childRef;

  console.log(
    `${prefix} full brain child started pid=${childRef.pid || "unknown"} internalPort=${internalPort} restart=${totalChildRestarts}.`
  );

  let failureHandled = false;
  const handleFailure = reason => {
    if (failureHandled || shuttingDown) return;
    failureHandled = true;
    if (child === childRef) child = null;
    scheduleBrainRestart(reason);
  };

  childRef.once("error", error => {
    console.error(`${prefix} child spawn failed: ${error?.stack || error}`);
    handleFailure("spawn-error");
  });

  childRef.once("exit", (code, signal) => {
    lastChildExitAt = new Date().toISOString();
    lastChildExitCode = code;
    lastChildExitSignal = signal || null;
    upstreamReady = false;

    if (shuttingDown) return;

    console.error(
      `${prefix} full brain child exited: code=${code ?? "null"} signal=${signal || "none"}.`
    );
    handleFailure("child-exit");
  });

  void waitForUpstream(childRef);
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${prefix} received ${signal}; shutting down parent and child.`);

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  if (child && child.exitCode == null) {
    try {
      child.kill(signal);
    } catch {}
  }

  bootstrapServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref?.();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

bootstrapServer.listen(externalPort, "0.0.0.0", () => {
  console.log(
    `${prefix} early Hostless listener active on ${externalPort}; full brain supervised on child port ${internalPort}.`
  );
  startBrainChild();
});

bootstrapServer.on("error", error => {
  console.error(`${prefix} failed to bind external port ${externalPort}: ${error?.stack || error}`);
  process.exit(1);
});
