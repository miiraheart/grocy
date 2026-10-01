// Run: node --test custom/grocy/tests/
// The WP4 shopping rules (17-32 merge, inbox parser, router and plan) against the case files shared with the app
// (tests/app/ContributionCasesFixtureTests.swift and InboxCasesFixtureTests.swift).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const part = (file) => fs.readFileSync(path.join(__dirname, "..", "companion", file), "utf8");
function load(file) {
	const module = { exports: {} };
	new Function("module", part(file).replace(/^[\s\S]*?<script>/, "").replace(/<\/script>[\s\S]*$/, ""))(module);
	return module.exports;
}
const lib = part("shopping-lib.js.html");
const fold = new Function("return " + lib.slice(lib.indexOf("/*fold*/") + 8, lib.indexOf("/*/fold*/")))();
const M = load("shopping-merge.js.html").make(fold);
const T = load("recipe-text.js.html");
const I = load("shopping-inbox-rules.js.html").make(fold, M, T.parseLine);
const cases = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, name), "utf8"));
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg + ": " + a + " vs " + b);

function sameDecision(got, want, msg) {
	assert.equal(got.kind, want.kind, msg);
	for (const k of Object.keys(want)) {
		if (typeof want[k] === "number") near(got[k], want[k], msg + " " + k);
		else assert.deepEqual(got[k], want[k], msg + " " + k);
	}
}

test("fold: the app's fold.json", () => {
	const file = path.join(__dirname, "fold.json");
	if (!fs.existsSync(file)) return;
	for (const c of JSON.parse(fs.readFileSync(file, "utf8"))) assert.equal(fold(c.input), c.output, c.input);
});

test("merge: shared decide, resolve and default choice cases", () => {
	const doc = cases("contribution-cases.json");
	for (const c of doc.decide) {
		const d = M.decide(c.row, c.incoming, doc.conversions);
		sameDecision(d, c.expect, c.name);
		for (const r of c.resolve || []) {
			const got = M.resolve(d, r.choice);
			if (r.expect === null) assert.equal(got, null, c.name + " " + r.choice.kind);
			else { near(got.amount, r.expect.amount, c.name); assert.equal(got.note, r.expect.note, c.name); }
		}
		for (const x of c.defaultChoice || []) assert.equal(M.defaultChoice(d, x.explicit).kind, x.expect, c.name);
	}
});

test("merge: captions and share removal", () => {
	const doc = cases("contribution-cases.json");
	for (const c of doc.captions) assert.equal(M.caption(c.amount, c.shares, (id) => c.names[id], c.language), c.expect, c.expect);
	for (const c of doc.remove) assert.deepEqual(M.removeShare(c.amount, c.shares, c.recipe, c.mealPlan), c.expect);
});

test("inbox: parser cases", () => {
	for (const c of cases("inbox-cases.json").parser) {
		const r = I.rules(c.text), e = c.expect;
		if (e.count !== undefined) assert.equal(r.items.length, e.count, c.name);
		if (e.names) e.names.forEach((n, i) => { if (n !== null) assert.equal(r.items[i].name, n, c.name); });
		if (e.nameContains) e.nameContains.forEach((n, i) => { if (n) assert.ok(r.items[i].name.includes(n), c.name); });
		if (e.amounts) assert.deepEqual(r.items.map((x) => x.amount), e.amounts, c.name);
		if (e.units) assert.deepEqual(r.items.map((x) => x.unit), e.units, c.name);
		if (e.qtyTexts) assert.deepEqual(r.items.map((x) => x.qtyText), e.qtyTexts, c.name);
		if (e.hints) assert.deepEqual(r.items.map((x) => x.listHint), e.hints, c.name);
		if (e.minConfidence !== undefined) assert.ok(r.confidence >= e.minConfidence, c.name);
		if (e.maxConfidence !== undefined) assert.ok(r.confidence <= e.maxConfidence, c.name + " " + r.confidence);
		if (e.confidence !== undefined) assert.equal(r.confidence, e.confidence, c.name);
	}
});

test("inbox: router cases", () => {
	const doc = cases("inbox-cases.json").route;
	for (const c of doc.cases) {
		const lists = doc.lists.map((l) => ({ ...l, locked: (c.locked || []).includes(l.id), memory: (c.listMemory || {})[l.id] || { items: {} } }));
		const ctx = { lists, productMemory: c.productMemory || {}, productGroup: doc.productGroup, currentListId: 1 };
		assert.equal(I.route(c.productId, c.key, c.hint, ctx), c.expect, c.name);
	}
});

test("inbox: plan cases", () => {
	const p = cases("inbox-cases.json").plan;
	const lists = p.lists.map((l) => ({ id: l.id, name: l.name, type: "grocery", locked: false, memory: { items: {} } }));
	const snap = { products: p.catalog.products, units: p.catalog.units, conversions: p.catalog.conversions, rows: p.rows,
		route: { lists, productMemory: {}, productGroup: {}, currentListId: p.currentListId }, processed: {} };
	for (const c of p.cases) {
		const lines = I.plan(I.rules(c.text).items, c.entryId, snap);
		assert.equal(lines.length, c.expect.length, c.name);
		c.expect.forEach((e, i) => {
			const l = lines[i], msg = c.name + " #" + i;
			for (const k of ["name", "productId", "listId"]) assert.equal(l[k], e[k], msg + " " + k);
			near(l.amount, e.amount, msg + " amount");
			if ("quId" in e) assert.equal(l.quId, e.quId, msg + " quId");
			if ("qtyText" in e) assert.equal(l.qtyText, e.qtyText, msg + " qtyText");
			sameDecision(l.decision, e.decision, msg);
			assert.equal(l.choice.kind, e.choice, msg + " choice");
			const a = I.applyLine(l);
			if (e.action === null) assert.equal(a, null, msg);
			else { assert.equal(a.action.kind, e.action.kind, msg); if (e.action.amount !== undefined) near(a.action.amount, e.action.amount, msg); }
			if (e.draft) { near(a.draft.amount, e.draft.amount, msg); assert.equal(a.draft.qtyText, e.draft.qtyText, msg); }
		});
		if (c.move) {
			const m = I.moved(lines[c.move.line], c.move.to, c.entryId, snap);
			sameDecision(m.decision, c.move.expect.decision, c.name + " moved");
			assert.equal(m.choice.kind, c.move.expect.choice);
		}
	}
});

test("inbox: the document keeps 50 entries, dropping old done ones first", () => {
	const doc = { v: 1, entries: [] };
	for (let i = 0; i < 50; i++) I.insert(doc, { id: "e" + i, text: "x", source: "paste", created: "2026-09-" + String(i % 28 + 1).padStart(2, "0"), status: i === 3 ? "done" : "new", processed: [] });
	I.insert(doc, { id: "late", text: "a".repeat(30000), source: "web", created: "2026-10-01", status: "new", processed: [] });
	assert.equal(doc.entries.length, 50);
	assert.ok(!doc.entries.some((e) => e.id === "e3"));
	assert.equal(doc.entries.find((e) => e.id === "late").text.length, 20000);
	assert.deepEqual(I.processedRows({ entries: [{ id: "a", processed: [1, 2] }, { id: "b", processed: [2] }] }), { 1: ["a"], 2: ["a", "b"] });
	assert.equal(I.title("Salut !\nlait\npain"), "lait");
});
