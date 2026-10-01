// Loads the Code node sources the way build.mjs pastes them, for node --test.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const source = (file) => readFileSync(join(DIR, file), "utf8");

export function loadLib(files, names) {
  const code = files.map(source).join("\n") + "\nreturn { " + names.join(", ") + " };";
  return new Function(code)();
}

// Runs a Code node body built from these files with one input item, like n8n does.
export async function runCode(files, json, helpers = {}) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("$input", "$", files.map(source).join("\n"));
  const out = await fn.call({ helpers }, { first: () => ({ json }) }, () => { throw new Error("no other nodes in tests"); });
  return out[0].json;
}
