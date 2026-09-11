import { register } from "node:module";
import { pathToFileURL } from "node:url";

const prefix = "[v10.69.9.6.4]";
console.log(`${prefix} bootstrap entered; loading known-good v10.69.9.3 chain first.`);

try {
  await import("./v106993Register.mjs");
  console.log(`${prefix} known-good v10.69.9.3 chain registered.`);
  register("./v1069964Loader.mjs", pathToFileURL("./"));
  console.log(`${prefix} robust 24-month loader registered.`);
  await import("./server.js");
} catch (error) {
  console.error(`${prefix} FATAL before/while importing server.js:`);
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
}
