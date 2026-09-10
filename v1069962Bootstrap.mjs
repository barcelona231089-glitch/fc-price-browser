import { register } from "node:module";
import { pathToFileURL } from "node:url";

const prefix = "[v10.69.9.6.2]";
console.log(`${prefix} bootstrap entered; preparing known-good v10.69.9.3 base.`);

try {
  // Register only the already proven v10.69.9.3 chain first.
  await import("./v106993Register.mjs");
  console.log(`${prefix} known-good v10.69.9.3 loader chain registered.`);

  // One consolidated layer applies 9.6 + 9.6.1 changes fail-soft.
  register("./v1069962Loader.mjs", pathToFileURL("./"));
  console.log(`${prefix} consolidated 24m fail-safe loader registered.`);

  await import("./server.js");
} catch (error) {
  console.error(`${prefix} FATAL before/while importing server.js:`);
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
}
