import { test } from "node:test";
import assert from "node:assert/strict";
import { runCode, source } from "./load.mjs";

const PLAN = ["lines-lib.js", "html-lib.js", "parse-plan.js"];
const READ = ["lines-lib.js", "net-lib.js", "grocy-lib.js", "html-lib.js", "read.js"];
const ctx = (extra = {}) => ({ recipe_id: 1, kind: "url", source_kind: "web", url: "https://example.org/r", ref: "", text: "", options: { heuristic: true }, ...extra });
const plan = (html, extra = {}, more = {}) => runCode(PLAN, { ctx: ctx(extra), html, page: { title: "Page title" }, ...more });

for (const page of ["jsonld-graph", "microdata", "headings"]) {
  test("saved page " + page + " gives its expected draft without the model", async () => {
    const expected = JSON.parse(source("test/pages/" + page + ".expected.json"));
    const out = await plan(source("test/pages/" + page + ".html"));
    assert.equal(out.needs_model, false);
    assert.equal(out.parser, expected.parser);
    const p = out.partial;
    for (const key of ["name", "servings", "servings_text", "times", "image_url", "author", "tags"]) assert.deepEqual(p[key], expected[key], key);
    assert.deepEqual(p.groups.flatMap((g) => g.lines).map((l) => [l.raw, l.quantity, l.unit, l.name]), expected.lines);
    assert.deepEqual(p.steps.map((s) => [s.section, s.text]), expected.steps);
  });
}

test("heuristic off sends the page text to the free model", async () => {
  const out = await plan(source("test/pages/headings.html"), { options: { heuristic: false } });
  assert.equal(out.needs_model, true);
  assert.match(out.model_text, /30 g de beurre/);
  assert.ok(out.openrouter_body.models.every((m) => m.endsWith(":free")));
  assert.equal(out.openrouter_body.response_format.json_schema.strict, true);
  assert.ok(!/diet_flags/.test(JSON.stringify(out.openrouter_body)));
});

test("pasted text with headings is parsed by rules", async () => {
  const text = "ZZ test poulet coco\nPour 4 personnes\nIngrédients\n600 g de poulet\n40 cl de lait de coco\n1 c.à.s. de curry\nPréparation\n1. Dorer le poulet.\n2. Ajouter le lait de coco et mijoter 20 min.";
  const out = await runCode(PLAN, { ctx: ctx({ kind: "text", source_kind: "text", url: "", text }), text, page: {} });
  assert.equal(out.parser, "rules");
  assert.equal(out.partial.name, "ZZ test poulet coco");
  assert.equal(out.partial.servings, 4);
  assert.deepEqual(out.partial.groups[0].lines.map((l) => [l.quantity, l.unit, l.name]), [[600, "g", "poulet"], [40, "cl", "lait de coco"], [1, "tbsp", "curry"]]);
  assert.equal(out.partial.steps.length, 2);
});

test("prose goes to the model, errors pass through", async () => {
  const text = "Pour ce poulet coco il faut faire dorer du poulet avec un peu de curry puis verser le lait de coco et laisser mijoter.";
  const out = await runCode(PLAN, { ctx: ctx({ kind: "text", url: "", text }), text, page: {} });
  assert.equal(out.needs_model, true);
  assert.equal(out.openrouter_body.messages[1].content, text);
  const failed = await runCode(PLAN, { ctx: ctx(), error: { stage: "read", message: "x" } });
  assert.deepEqual([failed.needs_model, failed.error.stage], [false, "read"]);
});

test("a TikTok caption without ingredient lines fails at read", async () => {
  const helpers = { httpRequest: async () => ({ title: "Le meilleur poulet de ma vie 😍 #food #recette", author_unique_id: "chef", thumbnail_url: "https://p16/x.jpg" }) };
  const out = await runCode(READ, { ctx: ctx({ source_kind: "tiktok", url: "https://www.tiktok.com/@chef/video/123" }) }, helpers);
  assert.deepEqual(out.error, { stage: "read", message: "no written recipe in this post" });
  const ok = await runCode(READ, { ctx: ctx({ source_kind: "tiktok", url: "https://www.tiktok.com/@chef/video/123" }) },
    { httpRequest: async () => ({ title: "Poulet coco 🥥\n🍗 600 g de poulet\n🥥 40 cl de lait de coco\nDorer puis mijoter.", author_unique_id: "chef" }) });
  assert.equal(ok.error, undefined);
  assert.equal(ok.page.author, "@chef");
});

test("private and non http links are refused before any fetch", async () => {
  for (const url of ["http://grocy/api/recipes", "http://192.168.1.10/x", "http://100.101.1.2/", "file:///etc/passwd", "https://grocy.audibox.cc/"]) {
    const out = await runCode(READ, { ctx: ctx({ url }) }, { httpRequest: async () => { throw new Error("fetched " + url); } });
    assert.equal(out.error.stage, "resolve", url);
  }
});
