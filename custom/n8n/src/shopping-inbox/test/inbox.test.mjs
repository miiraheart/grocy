// Run: node --test custom/n8n/src/shopping-inbox/test/
// The shopping-inbox Code nodes run the way n8n runs them, and the built twin only knows the test credential and a :free model.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = join(DIR, "..", "..", "templates");
const source = (f) => readFileSync(join(DIR, f), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function run(file, json, nodes = {}) {
	const out = await new AsyncFunction("$input", "$", source(file))({ first: () => ({ json }) }, (name) => ({ first: () => ({ json: nodes[name] }) }));
	return out[0].json;
}
const SECRET = "__WEBHOOK_SECRET__";
const ask = (body, secret = SECRET) => run("prepare.js", { headers: { "x-trigger-secret": secret }, body });

test("prepare: the secret, an empty text and a text over 20000 characters", async () => {
	assert.equal((await ask({ text: "lait" }, "nope")).http_status, 401);
	assert.equal((await ask({ text: "  " })).http_status, 400);
	const big = await ask({ text: "a".repeat(20001) });
	assert.equal(big.http_status, 413);
	assert.equal(big.reply.ok, false);
});

test("prepare: one structured request on free models with the lists in the prompt", async () => {
	const p = await ask({ text: "coucou, tu peux prendre du lait stp", lists: ["Courses", "Biocoop", 3, ""], language_hint: "fr" });
	assert.equal(p.needs_model, true);
	assert.deepEqual(p.lists, ["Courses", "Biocoop"]);
	assert.ok(p.openrouter_body.models.every((m) => m.endsWith(":free")));
	assert.equal(p.openrouter_body.response_format.json_schema.name, "shopping_inbox");
	assert.ok(p.openrouter_body.messages[0].content.includes("Lists: Courses, Biocoop."));
	assert.equal(p.openrouter_body.messages[1].content, "coucou, tu peux prendre du lait stp");
});

test("reply: names kept, amounts positive, list hints only from the given lists", async () => {
	const content = JSON.stringify({ items: [
		{ name: " lait ", amount: null, unit: null, list: "biocoop" }, { name: "baguettes", amount: 2, unit: null, list: "Carrefour" },
		{ name: "", amount: 1, unit: null, list: null }, { name: "produit lave-vaisselle", amount: -1, unit: "PIECE", list: null }] });
	const r = await run("reply.js", { model: "qwen/qwen3.8-27b:free", choices: [{ message: { content } }] }, { Prepare: { lists: ["Courses", "Biocoop"] } });
	assert.equal(r.http_status, 200);
	assert.deepEqual(r.reply.items, [
		{ name: "lait", amount: null, unit: null, note: null, list_hint: "Biocoop" },
		{ name: "baguettes", amount: 2, unit: null, note: null, list_hint: null },
		{ name: "produit lave-vaisselle", amount: null, unit: "piece", note: null, list_hint: null }]);
	assert.equal(r.reply.parser, "openrouter:qwen/qwen3.8-27b:free");
	const bad = await run("reply.js", { error: { message: "timeout" } }, { Prepare: { lists: [] } });
	assert.equal(bad.http_status, 502);
	assert.equal((await run("reply.js", { choices: [{ message: { content: "no json" } }] }, { Prepare: { lists: [] } })).reply.ok, false);
});

test("the twin uses only the test credential and one :free model, the real one is imported inactive", () => {
	const twin = readFileSync(join(TEMPLATES, "shopping-inbox-test.json"), "utf8"), real = JSON.parse(readFileSync(join(TEMPLATES, "shopping-inbox.json"), "utf8"));
	const tw = JSON.parse(twin);
	const creds = tw.nodes.filter((n) => n.credentials).map((n) => n.credentials.openRouterApi.id);
	assert.deepEqual(creds, ["orTestKey0000001"]);
	const prepare = tw.nodes.find((n) => n.name === "Prepare").parameters.jsCode;
	const models = [...prepare.matchAll(/"([a-z0-9-]+\/[a-zA-Z0-9.:_-]+)"/g)].map((m) => m[1]);
	assert.ok(models.length >= 1 && new Set(models).size === 1 && models[0].endsWith(":free"), models.join(","));
	assert.ok(prepare.includes("const TWIN = true;"));
	assert.ok(!twin.includes("l86vEWp9ZQt60YHZ"));
	assert.equal(tw.nodes.find((n) => n.type === "n8n-nodes-base.webhook").parameters.path, "shopping-inbox-test");
	assert.equal(real.active, false);
	assert.ok(!JSON.stringify(real).includes("http://grocy"), "the reader never calls Grocy");
});
