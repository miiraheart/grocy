// Run: node --test custom/grocy/tests/
// WP5 web assistant: the pure rules (shortlist, screen, cards, history format, action menu), every part parses,
// and every string has English and French with no dash characters.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DIR = path.join(__dirname, "..", "companion");
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");
function load(file) {
	const code = read(file).replace(/^[\s\S]*?<script>/, "").replace(/<\/script>[\s\S]*$/, "");
	const module = { exports: {} };
	new Function("module", code)(module);
	return module.exports;
}
const A = load("assistant-rules.js.html");
const PARTS = ["assistant-i18n", "assistant-rules", "assistant-history", "assistant-apply", "assistant-apply-more", "assistant-answer", "assistant-context",
	"assistant-session", "assistant-cards", "assistant", "assistant-activity"].map((p) => p + ".js.html");

test("every assistant part parses and stays under 300 lines", () => {
	for (const f of PARTS) {
		for (const m of read(f).matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(m[1]), f);
		assert.ok(read(f).split("\n").length < 300, f);
	}
});

test("every assistant string has English and French, no dash characters", () => {
	const d = {};
	for (const m of read("assistant-i18n.js.html").matchAll(/GL\.add\((\{[\s\S]*?\})\);/g)) Object.assign(d, new Function("return " + m[1])());
	const used = new Set();
	for (const f of PARTS) for (const m of read(f).matchAll(/GL\.t\("(as\.[a-zA-Z.]+)"/g)) used.add(m[1]);
	for (const op of Object.keys(A.KINDS)) used.add("as.op." + op);
	for (const k of ["inspect", "undo", "redo", "duplicate", "undoFromHere", "open"]) used.add("as.menu." + k);
	for (const k of ["applied", "edited", "undone", "failed", "undoFailed", "superseded"]) used.add("as.status." + k);
	for (const k of ["product", "target", "location", "date", "amount", "text"]) used.add("as.need." + k);
	for (const k of ["consume", "spoil", "listDone", "listUndone"]) used.add("as.sum." + k);
	for (const key of used) {
		if (/\.$/.test(key)) continue;
		assert.ok(d[key], "missing " + key);
		assert.equal(d[key].length, 2, key);
		assert.ok(d[key][0] && d[key][1], key);
	}
	for (const f of PARTS.concat(["assistant.css.html"])) assert.ok(!/[–—]/.test(read(f)), f + " has a dash character");
});

test("the shortlist puts the products she named first, then screen and stock", () => {
	const products = [{ id: 1, name: "Lait demi-écrémé" }, { id: 2, name: "Yaourt nature" }, { id: 3, name: "Riz basmati" }, { id: 4, name: "Beurre doux", active: 0 }, { id: 5, name: "Abricots secs" }];
	const s = A.shortlist("j'ai mangé deux yaourts et du riz", products, [5], [1], 10);
	assert.deepEqual(s.slice(0, 2).map((p) => p.id).sort(), [2, 3]);
	assert.equal(s[2].id, 5);
	assert.equal(s[3].id, 1);
	assert.ok(!s.some((p) => p.id === 4), "archived products stay out");
	assert.equal(A.shortlist("x", products, [], [], 2).length, 2);
});

test("the screen comes from the address like the app's screen context", () => {
	assert.deepEqual(A.screenIds("/product/12", ""), { product: 12 });
	assert.deepEqual(A.screenIds("/stockentries", "?product=7"), { product: 7 });
	assert.deepEqual(A.screenIds("/stockentry/40", ""), { entry: 40 });
	assert.deepEqual(A.screenIds("/shoppinglist", "?list=3"), { list: 3 });
	assert.deepEqual(A.screenIds("/shoppinglist", ""), { list: "active" });
	assert.deepEqual(A.screenIds("/recipes", "?recipe=9"), { recipe: 9 });
	assert.deepEqual(A.screenIds("/task/4", ""), { task: 4 });
	assert.deepEqual(A.screenIds("/chore/2", ""), { chore: 2 });
	assert.deepEqual(A.screenIds("/stockoverview", ""), {});
});

test("cards say what they still need, updates keep what was not said", () => {
	assert.equal(A.missing({ op: "consume", product_id: null }), "product");
	assert.equal(A.missing({ op: "add", product_id: null, name_fr: "Tahini" }), null);
	assert.equal(A.missing({ op: "move", product_id: 3, target_location_id: null }), "location");
	assert.equal(A.missing({ op: "chore_done", target_id: null }), "target");
	assert.equal(A.missing({ op: "set_amount", product_id: 3, amount: null }), "amount");
	assert.equal(A.missing({ op: "out_of", values: ["lait"] }), null);
	assert.equal(A.missing({ op: "recipe_star" }), null);
	assert.equal(A.supported({ op: "recipe_star" }), false);
	assert.equal(A.supported({ op: "ask" }), true);
	const m = A.merge({ op: "add", product_id: 2, amount: 2, location_id: 3, best_before: null }, { amount: 3, location_id: null, best_before: "2026-10-14" });
	assert.deepEqual([m.amount, m.location_id, m.best_before, m.best_before_source], [3, 3, "2026-10-14", "spoken"]);
});

test("a history entry goes to the gc_actions fields and back", () => {
	const rec = { action_id: "a1", created: "2026-10-01T10:00:00+02:00", kind: "stockAdd", status: "applied", origin: "web", source: "typed", session_id: "s1",
		parent_id: null, summary: "Added 2 Yaourt", sentence: "2 yaourts", record: { v: 1, undo: [{ method: "POST", path: "stock/transactions/x/undo" }] } };
	const f = A.toFields(rec);
	assert.equal(f.parent_id, "");
	assert.equal(typeof f.record, "string");
	const back = A.fromRow({ id: 9, userfields: f });
	assert.equal(back.row_id, 9);
	assert.equal(back.parent_id, null);
	assert.deepEqual(back.record, rec.record);
	assert.equal(A.fromRow({ id: 1, userfields: { record: "{bad" } }), null);
	assert.match(A.stamp(new Date()), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test("the action menu follows the app: undo needs calls, redo needs an undone web operation", () => {
	const undo = [{ method: "POST", path: "stock/transactions/t/undo" }];
	const op = { op: "add", product_id: 2, amount: 1 };
	const a = { action_id: "a", session_id: "s", created: "1", status: "applied", record: { op, undo, product_id: 2 } };
	const b = { action_id: "b", session_id: "s", created: "2", status: "applied", record: { op, undo, product_id: 2 } };
	const phone = { action_id: "c", session_id: "p", created: "3", status: "applied", record: { object_type: "task", object_id: "4" } };
	const gone = { action_id: "d", session_id: "s", created: "0", status: "undone", record: { op, undo, product_id: 2 } };
	assert.deepEqual(A.menu(a, [a, b]), ["inspect", "undo", "duplicate", "undoFromHere", "open"]);
	assert.deepEqual(A.menu(b, [a, b]), ["inspect", "undo", "duplicate", "open"]);
	assert.deepEqual(A.menu(phone, [phone]), ["inspect", "open"]);
	assert.deepEqual(A.menu(gone, [gone]), ["inspect", "redo", "open"]);
	assert.deepEqual(A.fromHere(a, [a, b, gone]).map((r) => r.action_id), ["b", "a"]);
	assert.equal(A.link(phone), "/task/4");
	assert.equal(A.link({ record: { object_type: "listItem", list_id: 2 } }), "/shoppinglist?list=2");
});
