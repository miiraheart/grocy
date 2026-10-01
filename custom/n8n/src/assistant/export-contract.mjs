// Exports the app's assistant intake contract (schema, prompt rules, models) to contract.json, so the web workflow
// and the iOS app read the same words. Source: the app repo, read only.
//   node export-contract.mjs [app repo]      writes contract.json
//   node export-contract.mjs [app repo] --check   exits 1 when contract.json is behind the app
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONTRACT_FILE = join(HERE, "contract.json");

/// The body of a Swift multi line string `static let name = """ ... """` (or #""" ... """#), indentation removed.
export function swiftString(source, name) {
  const m = new RegExp("static let " + name + " = (#?)\"\"\"\\n([\\s\\S]*?)\\n([ \\t]*)\"\"\"\\1").exec(source);
  if (!m) throw new Error("no string " + name);
  const indent = m[3].length;
  const body = m[2].split("\n").map((l) => l.slice(Math.min(indent, l.length - l.trimStart().length))).join("\n");
  if (!m[1] && /\\\(/.test(body)) throw new Error(name + " has interpolation");
  return m[1] ? body : body.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
}

const block = (source, start) => {
  const i = source.indexOf(start);
  if (i < 0) throw new Error("missing " + start);
  return source.slice(i, source.indexOf("]", source.indexOf("= [", i)) + 1);
};
const strings = (text) => [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

/// QueryKind case names to raw values (`case listItem = "list_item"`).
function queryRaw(source) {
  const body = source.slice(source.indexOf("enum QueryKind"), source.indexOf("static let mealQueries"));
  const map = {};
  for (const line of body.split("\n").filter((l) => /^\s*case /.test(l))) {
    for (const part of line.replace(/^\s*case /, "").split(",")) {
      const [k, raw] = part.split("=").map((s) => s.trim());
      if (k) map[k] = raw ? raw.replace(/"/g, "") : k;
    }
  }
  return map;
}

function mealSchema(mealArgs) {
  const fields = [...block(mealArgs, "static let schemaFields").matchAll(/\("([a-z_]+)", \.([a-z]+)\)/g)];
  const props = fields.map(([, key, type]) => type === "strings" || type === "integers"
    ? `"${key}": { "type": ["array", "null"], "items": { "type": "${type === "strings" ? "string" : "integer"}" } }`
    : `"${key}": { "type": ["${type}", "null"] }`);
  return `{ "type": ["object", "null"], "description": "Arguments of recipe, plan, cook and import operations; null when none", "properties": { `
    + props.join(", ") + ` }, "required": [${fields.map((f) => `"${f[1]}"`).join(", ")}], "additionalProperties": false }`;
}

export function exportContract(app) {
  const src = (p) => readFileSync(join(app, "GrocyV2", p), "utf8");
  const prompt = src("Services/Assistant/IntakePrompt.swift");
  const intents = src("Models/AssistantIntents.swift");
  const raw = queryRaw(intents);
  const mealOps = [...new Set([...block(src("Models/IntakeIntent+Meals.swift"), "static let mealOps").matchAll(/"([a-z_]+)": \./g)].map((m) => m[1]))].sort();
  const mealQueries = [...block(intents, "static let mealQueries").matchAll(/\.([a-zA-Z]+)/g)].map((m) => raw[m[1]]);
  const schemaText = swiftString(src("Services/Assistant/IntakeSchema.swift"), "template")
    .replace("\"MEAL_OPS\"", mealOps.map((o) => `"${o}"`).join(", "))
    .replace("\"MEAL_QUERIES\"", mealQueries.map((q) => `"${q}"`).join(", "))
    .replace("\"meal\": {}", "\"meal\": " + mealSchema(src("Models/MealArgs.swift")));
  const settings = src("Utilities/AssistantSettings.swift");
  const areas = src("Services/Assistant/IntakePrompt+Areas.swift");
  return {
    source: "GrocyV2/Services/Assistant (IntakeSchema, IntakePrompt, IntakePrompt+Stock, +Areas, +Chores, +List), Utilities/AssistantSettings",
    schema_name: /static let name = "([^"]+)"/.exec(src("Services/Assistant/IntakeSchema.swift"))[1],
    schema: JSON.parse(schemaText),
    rules: swiftString(prompt, "rules"),
    stock_detail_rules: swiftString(src("Services/Assistant/IntakePrompt+Stock.swift"), "stockDetailRules"),
    area_preamble: swiftString(areas, "areaPreamble"),
    area_rules: {
      chores: swiftString(src("Services/Assistant/IntakePrompt+Chores.swift"), "choresRules"),
      list: swiftString(src("Services/Assistant/IntakePrompt+List.swift"), "listRules"),
    },
    models: { live: strings(block(settings, "static let defaultLiveModels")), free: strings(block(settings, "static let defaultFreeModels")) },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = process.argv.slice(2).find((a) => !a.startsWith("--")) || "/Users/kbs/projects/grocy";
  const text = JSON.stringify(exportContract(app), null, 1) + "\n";
  if (process.argv.includes("--check")) {
    const same = readFileSync(CONTRACT_FILE, "utf8") === text;
    console.log(same ? "contract.json matches the app" : "contract.json is behind the app: run node export-contract.mjs");
    process.exit(same ? 0 : 1);
  }
  writeFileSync(CONTRACT_FILE, text);
  console.log("wrote", CONTRACT_FILE);
}
