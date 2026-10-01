// Loads the Code node sources the way build.mjs pastes them, for node --test.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { libInSandbox, runInSandbox } from "./sandbox.mjs";

export const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const source = (file) => readFileSync(join(DIR, file), "utf8");

export const loadLib = (files, names) => libInSandbox(files.map(source).join("\n"), names);

// Runs a Code node body built from these files with one input item, inside the n8n task runner sandbox.
export async function runCode(files, json, helpers = {}) {
  const out = await runInSandbox(files.map(source).join("\n"), { helpers,
    $input: { first: () => ({ json }), all: () => [{ json }] }, $: () => { throw new Error("no other nodes in tests"); } });
  return out[0].json;
}
