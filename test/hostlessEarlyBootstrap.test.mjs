import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Hostless early bootstrap keeps health responsive while full brain runs in a child", () => {
  const source = readFileSync(new URL("../hostlessEarlyBootstrap.mjs", import.meta.url), "utf8");
  const listenIndex = source.indexOf("bootstrapServer.listen");
  const spawnDefinitionIndex = source.indexOf("child = spawn(");
  const childStartInvocationIndex = source.lastIndexOf("startBrainChild();");

  assert.ok(listenIndex >= 0, "early listener missing");
  assert.ok(spawnDefinitionIndex >= 0, "full brain child spawn missing");
  assert.ok(childStartInvocationIndex >= 0, "full brain child start invocation missing");
  assert.ok(listenIndex < childStartInvocationIndex, "full brain child starts before early listener is established");
  assert.match(source, /path === "\/"/);
  assert.match(source, /path === "\/healthz"/);
  assert.match(source, /path === "\/health"/);
  assert.match(source, /path === "\/api\/readiness"/);
  assert.match(source, /bootstrap:\s*"early-port-v2-child"/);
  assert.match(source, /buildMarker:\s*"sales-evidence-v1"/);
  assert.match(source, /\["\.\/v1069965LeakHotfixL7Bootstrap\.mjs"\]/);
});

test("production start uses early bootstrap and constrained Node heap", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

  assert.equal(pkg.scripts.start, "node ./hostlessEarlyBootstrap.mjs");
  assert.match(dockerfile, /NODE_OPTIONS="--max-old-space-size=160"/);
});
