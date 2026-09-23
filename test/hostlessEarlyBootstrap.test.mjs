import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Hostless early bootstrap keeps health responsive and supervises the full brain child", () => {
  const source = readFileSync(new URL("../hostlessEarlyBootstrap.mjs", import.meta.url), "utf8");
  const listenIndex = source.indexOf("bootstrapServer.listen");
  const spawnDefinitionIndex = source.indexOf("const childRef = spawn(");
  const childStartInvocationIndex = source.lastIndexOf("startBrainChild();");

  assert.ok(listenIndex >= 0, "early listener missing");
  assert.ok(spawnDefinitionIndex >= 0, "full brain child spawn missing");
  assert.ok(childStartInvocationIndex >= 0, "full brain child start invocation missing");
  assert.ok(listenIndex < childStartInvocationIndex, "full brain child starts before early listener is established");

  assert.match(source, /path === "\/healthz"/);
  assert.match(source, /path === "\/bootstrap-status"/);
  assert.match(source, /bootstrap:\s*"early-port-v3-supervisor"/);
  assert.match(source, /buildMarker:\s*"sales-evidence-v1"/);
  assert.match(source, /handleFailure\("child-exit"\)/);
  assert.match(source, /handleFailure\("spawn-error"\)/);
  assert.match(source, /NODE_OPTIONS:\s*process\.env\.HOSTLESS_BRAIN_NODE_OPTIONS/);
  assert.doesNotMatch(source, /child exited before parent shutdown/);
});

test("production start uses early bootstrap, proven brain heap, and HTTP healthz", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  const hostless = readFileSync(new URL("../hostless.yaml", import.meta.url), "utf8");

  assert.equal(pkg.scripts.start, "node ./hostlessEarlyBootstrap.mjs");
  assert.match(dockerfile, /NODE_OPTIONS="--max-old-space-size=320"/);
  assert.match(hostless, /type:\s*http/);
  assert.match(hostless, /http_path:\s*"\/healthz"/);
});
