import { register } from "node:module";
import { pathToFileURL } from "node:url";

const prefix = "[v10.69.9.6.5-L1]";
console.log(`${prefix} bootstrap entered; loading 6.5 archive chain + leak hotfix.`);

try {
  await import("./v106993Register.mjs");
  register("./v1069965Loader.mjs", pathToFileURL("./"));
  register("./v1069965LeakHotfixLoader.mjs", pathToFileURL("./"));
  console.log(`${prefix} 6.5 archive loader and public leak hotfix registered.`);
  await import("./server.js");
} catch (error) {
  console.error(`${prefix} FATAL before/while importing server.js:`);
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
}
