// node --test custom/n8n/src/assistant/test/
// The assistant-intake Code nodes with the shared contract: auth, the app's prompt parts, the model chain, and the
// reply checks (ids only from what the page sent).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DIR } from "../../recipe-import/test/load.mjs";
import { exportContract, CONTRACT_FILE } from "../export-contract.mjs";

const contract = readFileSync(CONTRACT_FILE, "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const prepareCode = (twin) => readFileSync(join(DIR, "..", "assistant", "prepare.js"), "utf8").replace("/*@CONTRACT@*/null", () => JSON.stringify(JSON.parse(contract)))
  .replace("const TWIN = false;", twin ? "const TWIN = true;" : "const TWIN = false;");
const replyCode = readFileSync(join(DIR, "..", "assistant", "reply.js"), "utf8");

async function prepare(body, { secret = "__WEBHOOK_SECRET__", twin = false } = {}) {
  const out = await new AsyncFunction("$input", "$", prepareCode(twin))({ first: () => ({ json: { headers: { "x-trigger-secret": secret }, body } }) }, null);
  return out[0].json;
}
async function reply(prep, model) {
  const out = await new AsyncFunction("$input", "$", replyCode)({ first: () => ({ json: model }) }, () => ({ first: () => ({ json: prep }) }));
  return out[0].json;
}
const BASE = {
  text: "j'ai acheté 4 yaourts au frigo", today: "2026-10-01", timezone: "Europe/Paris",
  locations: [{ id: 2, name: "Réfrigérateur", kind: "fridge" }, { id: 3, name: "Placard", kind: "pantry" }], units: [{ id: 2, name: "Pièce" }],
  shortlist: [{ id: 10, name: "Yaourt nature" }], tasks: [{ id: 5, name: "Appeler la banque", due: "2026-10-02" }],
  chores: [{ id: 7, name: "Aspirateur", next: "2026-10-01", rule: "weekly", room: null }], lists: [{ id: 1, name: "Courses" }], active_list_id: 1,
  screen: { product: { id: 11, name: "Lait" }, list: { id: 1, name: "Courses" } },
};

test("refuses a wrong secret, no text and a missing day", async () => {
  assert.equal((await prepare(BASE, { secret: "nope" })).http_status, 401);
  assert.equal((await prepare({ ...BASE, text: " " })).http_status, 400);
  assert.equal((await prepare({ ...BASE, today: "today" })).http_status, 400);
  assert.equal((await prepare({ ...BASE, text: "x".repeat(4001) })).http_status, 413);
});

test("builds the app's intake call from the shared contract", async () => {
  const p = await prepare(BASE);
  const c = JSON.parse(contract);
  const [system, user] = p.openrouter_body.messages;
  const sys = Array.isArray(system.content) ? system.content[0].text : system.content;
  assert.ok(sys.startsWith(c.rules));
  assert.ok(sys.includes(c.stock_detail_rules) && sys.includes(c.area_rules.chores) && sys.includes(c.area_rules.list));
  assert.ok(sys.includes("2|Réfrigérateur (fridge)") && sys.includes("Today: 2026-10-01 Thursday (Europe/Paris)"));
  assert.ok(sys.includes("What the web can do") && sys.includes("chore_done"));
  assert.ok(user.content.includes("Shortlist (id|name):\n10|Yaourt nature"));
  assert.ok(user.content.includes("product 11|Lait") && user.content.includes("shopping list 1|Courses"));
  assert.ok(user.content.includes("5|Appeler la banque|2026-10-02") && user.content.includes("1|Courses|active"));
  assert.ok(user.content.endsWith("Utterances:\n1.\n   text: \"j'ai acheté 4 yaourts au frigo\""));
  assert.deepEqual(p.openrouter_body.models, c.models.live);
  assert.equal(p.openrouter_body.response_format.json_schema.name, "kitchen_intake");
  assert.deepEqual(p.allowed.products.sort(), [10, 11]);
});

test("the twin runs the free chain with reasoning off", async () => {
  const p = await prepare(BASE, { twin: true });
  assert.ok(p.openrouter_body.models.every((m) => m.endsWith(":free")));
  assert.deepEqual(p.openrouter_body.reasoning, p.openrouter_body.models[0].includes("qwen3") || p.openrouter_body.models[0].includes("nemotron") ? { enabled: false } : undefined);
});

test("the reply keeps only ids the page sent and clean values", async () => {
  const prep = await prepare(BASE);
  const op = (o) => ({ op: "add", utterance: 1, product_id: null, amount: null, best_before: null, best_before_source: "none", location_id: null, target_id: null, ...o });
  const content = JSON.stringify({ heard: [{ utterance: 1, text: "x", reply_language: "fr", confirmation: "4 yaourts au frigo" }], operations: [
    op({ product_id: 10, amount: 4, location_id: 2, best_before: "2026-10-14", best_before_source: "spoken" }),
    op({ product_id: 999, amount: -1, location_id: 99, best_before: "14/10" }),
    op({ op: "chore_done", target_id: 7 }), op({ op: "task_done", target_id: 77 }), op({ op: "invented" }),
  ] });
  const r = await reply(prep, { model: "x/y:free", choices: [{ message: { content } }] });
  assert.equal(r.http_status, 200);
  const [a, b, chore, task] = r.reply.operations;
  assert.equal(r.reply.operations.length, 4);
  assert.deepEqual([a.product_id, a.amount, a.location_id, a.best_before, a.best_before_source], [10, 4, 2, "2026-10-14", "spoken"]);
  assert.deepEqual([b.product_id, b.amount, b.location_id, b.best_before, b.best_before_source], [null, null, null, null, "none"]);
  assert.equal(chore.target_id, 7);
  assert.deepEqual([task.target_id, task.needs_clarification], [null, true]);
  assert.equal(r.reply.heard[0].confirmation, "4 yaourts au frigo");
  assert.equal((await reply(prep, { error: { message: "429" } })).http_status, 502);
  assert.equal((await reply(prep, { choices: [{ message: { content: "not json" } }] })).http_status, 502);
});

test("contract.json is the app's contract", { skip: !existsSync("/Users/kbs/projects/grocy/GrocyV2") && "app repo not here" }, () => {
  assert.equal(JSON.stringify(exportContract("/Users/kbs/projects/grocy"), null, 1) + "\n", contract);
});
