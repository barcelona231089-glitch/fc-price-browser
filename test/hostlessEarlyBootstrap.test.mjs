import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Hostless early bootstrap binds externally before loading the full brain", () => {
  const source = readFileSync(new URL("../hostlessEarlyBootstrap.mjs", import.meta.url), "utf8");
  const listenIndex = source.indexOf("bootstrapServer.listen");
  const brainImportIndex = source.indexOf('import("./v1069965LeakHotfixL7Bootstrap.mjs")');

  assert.ok(listenIndex >= 0, "early listener missing");
  assert.ok(brainImportIndex >= 0, "full brain import missing");
  assert.ok(listenIndex < brainImportIndex, "full brain loads before early listener is established");
  assert.match(source, /readiness:\s*fatalError \? "bootstrap-failed" : "booting"/);
  assert.match(source, /buildMarker:\s*"sales-evidence-v1"/);
});

test("production start uses early bootstrap and constrained Node heap", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

  assert.equal(pkg.scripts.start, "node ./hostlessEarlyBootstrap.mjs");
  assert.match(dockerfile, /NODE_OPTIONS="--max-old-space-size=160"/);
});
