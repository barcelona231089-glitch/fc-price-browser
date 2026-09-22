import http from "node:http";
import { spawn } from "node:child_process";

const prefix = "[hostless-early-bootstrap-v2]";
const externalPort = Number(process.env.PORT || 3000);
const configuredInternalPort = Number(process.env.HOSTLESS_INTERNAL_PORT || 0);
const internalPort = configuredInternalPort > 0
  ? configuredInternalPort
  : (externalPort >= 65534 ? externalPort - 1 : externalPort + 1);

let upstreamReady = false;
let fatalError = null;
let child = null;
let shuttingDown = false;

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store"
  });
  res.end(payload);
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

function isBootstrapProbe(url = "/") {
  const path = String(url).split("?", 1)[0];
  return path === "/" || path === "/healthz" || path === "/health" || path === "/api/readiness";
}

const bootstrapServer = http.createServer((req, res) => {
  if (!upstreamReady) {
    if (isBootstrapProbe(req.url)) {
      return json(res, fatalError ? 500 : 200, {
        ok: !fatalError,
        service: "fc-trader-brain",
        readiness: fatalError ? "bootstrap-failed" : "booting",
        bootstrap: "early-port-v2-child",
        buildMarker: "sales-evidence-v1"
      });
    }

    return json(res, 503, {
      ok: false,
      service: "fc-trader-brain",
      readiness: fatalError ? "bootstrap-failed" : "booting"
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

async function waitForUpstream() {
  while (!shuttingDown && child && child.exitCode == null) {
    if (await probeUpstream()) {
      upstreamReady = true;
      console.log(`${prefix} full brain ready on internal port ${internalPort}; proxy enabled.`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

function startBrainChild() {
  const childEnv = {
    ...process.env,
    PORT: String(internalPort),
    HOSTLESS_PARENT_PORT: String(externalPort),
    HOSTLESS_EARLY_BOOTSTRAP_CHILD: "1"
  };

  child = spawn(
    process.execPath,
    ["./v1069965LeakHotfixL7Bootstrap.mjs"],
    {
      cwd: process.cwd(),
      env: childEnv,
      stdio: "inherit",
      windowsHide: true
    }
  );

  console.log(`${prefix} full brain child started pid=${child.pid || "unknown"} internalPort=${internalPort}.`);

  child.once("error", error => {
    fatalError = error;
    console.error(`${prefix} child spawn failed: ${error?.stack || error}`);
  });

  child.once("exit", (code, signal) => {
    if (shuttingDown) return;

    fatalError = new Error(
      `full brain child exited before parent shutdown: code=${code ?? "null"} signal=${signal || "none"}`
    );
    upstreamReady = false;
    console.error(`${prefix} ${fatalError.message}`);

    setTimeout(() => process.exit(code || 1), 1000).unref?.();
  });

  void waitForUpstream();
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${prefix} received ${signal}; shutting down parent and child.`);

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
    `${prefix} early Hostless listener active on ${externalPort}; full brain isolated on child port ${internalPort}.`
  );
  startBrainChild();
});

bootstrapServer.on("error", error => {
  console.error(`${prefix} failed to bind external port ${externalPort}: ${error?.stack || error}`);
  process.exit(1);
});
