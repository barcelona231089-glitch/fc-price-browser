import test from "node:test";
import assert from "node:assert/strict";
import { patchPublicLeaksV1069965L1 } from "../v1069965LeakHotfixLoader.mjs";

test("adds multi-source public leaks and next-game-year intake", () => {
  const fixture = `const PUBLIC_LEAK_X_HANDLES = String(\n  process.env.PUBLIC_LEAK_X_HANDLES || "FutSheriff"\n)\n\nfunction publicLeakMatchesGameYear(text) {\n  const matches = [...String(text || "").matchAll(/\\b(?:EA\\s*SPORTS\\s*)?FC\\s*(2[67])\\b/gi)]\n    .map(item => item[1]);\n  if (!matches.length) return true;\n  return matches.includes(GAME_YEAR);\n}`;
  const out = patchPublicLeaksV1069965L1(fixture);
  assert.match(out, /FutSheriff,FutPoliceLeaks,Criminal__x,Futdonk/);
  assert.match(out, /PUBLIC_LEAK_ACCEPT_NEXT_GAME_YEAR/);
  assert.match(out, /String\(current \+ 1\)\.padStart\(2, "0"\)/);
});
