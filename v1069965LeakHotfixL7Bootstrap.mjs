import { register } from "node:module";
import { pathToFileURL } from "node:url";

const prefix = "[v10.69.9.6.5-L7]";
console.log(`${prefix} bootstrap entered; loading archive + leak stack + zero-cost trader expansion.`);

try {
  await import("./v106993Register.mjs");
  register("./v1069965Loader.mjs", pathToFileURL("./"));
  register("./v1069965LeakHotfixLoader.mjs", pathToFileURL("./"));
  register("./v1069965LeakHotfixL2Loader.mjs", pathToFileURL("./"));
  register("./v1069965LeakHotfixL3Loader.mjs", pathToFileURL("./"));
  register("./v1069965LeakHotfixL4Loader.mjs", pathToFileURL("./"));
  register("./v1069965LeakHotfixL5Loader.mjs", pathToFileURL("./"));
  register("./v1069965LeakHotfixL6Loader.mjs", pathToFileURL("./"));
  register("./v1069965LeakHotfixL7Loader.mjs", pathToFileURL("./"));
  console.log(`${prefix} 6.5 + L1-L7 loaders registered.`);
  await import("./server.js");
} catch (error) {
  console.error(`${prefix} FATAL before/while importing server.js:`);
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
}
