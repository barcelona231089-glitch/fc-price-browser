import { register } from "node:module";
import { pathToFileURL } from "node:url";

const prefix = "[v10.69.9.6.5-L4]";
console.log(`${prefix} bootstrap entered; loading archive + leak stack + official X API.`);

try {
  await import("./v106993Register.mjs");
  register("./v1069965Loader.mjs", pathToFileURL("./"));
  register("./v1069965LeakHotfixLoader.mjs", pathToFileURL("./"));
  register("./v1069965LeakHotfixL2Loader.mjs", pathToFileURL("./"));
  register("./v1069965LeakHotfixL3Loader.mjs", pathToFileURL("./"));
  register("./v1069965LeakHotfixL4Loader.mjs", pathToFileURL("./"));
  console.log(`${prefix} 6.5 + L1 + L2 + L3 + L4 loaders registered.`);
  await import("./server.js");
} catch (error) {
  console.error(`${prefix} FATAL before/while importing server.js:`);
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
}
