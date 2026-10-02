// Run: node --test custom/grocy/tests/
// The dashboard and recipe rules of WP3 against the case files shared with the app (tests/app/MealsCasesFixtureTests.swift).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function load(file) {
	const html = fs.readFileSync(path.join(__dirname, "..", "companion", file), "utf8");
	const module = { exports: {} };
	new Function("module", html.replace(/^[\s\S]*?<script>/, "").replace(/<\/script>[\s\S]*$/, ""))(module);
	return module.exports;
}
const cases = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, name), "utf8"));
const D = load("shopping-diet.js.html"), T = load("recipe-text.js.html"), G = load("dash-rules.js.html");
const R = load("recipe-rules.js.html").make(D, T);

test("ingredient lines: the app's parser corpus", () => {
	for (const c of cases("ingredient-lines.json")) {
		const r = T.parseLine(c.raw);
		for (const k of Object.keys(c.expect)) {
			if (typeof c.expect[k] === "number") assert.ok(Math.abs(r[k] - c.expect[k]) < 1e-9, c.raw + " " + k);
			else assert.deepEqual(r[k], c.expect[k], c.raw + " " + k);
		}
	}
});

test("timers: shared cases", () => {
	for (const c of cases("timer-cases.json").cases) {
		assert.deepEqual(T.timers(c.text).map((t) => ({ match: c.text.slice(t.start, t.end), seconds: t.seconds, maxSeconds: t.maxSeconds })), c.expect, c.text);
	}
});

test("use soon: shared cases", () => {
	const doc = cases("dashboard-cases.json");
	for (const c of doc.useSoon) {
		const got = G.useSoon(c.volatile, c.stock, doc.today).map((i) => ({ productId: i.productId, status: i.status.kind, days: i.days == null ? null : i.days, opened: i.opened, canOpen: i.canOpen }));
		assert.deepEqual(got, c.expect, c.name);
	}
});

test("today meals and thaw: shared cases", () => {
	const doc = cases("dashboard-cases.json");
	for (const c of doc.meals) {
		assert.deepEqual(G.meals(c.rows, c.day, c.sections, c.recipes, c.names).map((m) => ({ name: m.name, section: m.section, isRecipe: m.isRecipe, done: m.done })), c.expect, c.name);
	}
	for (const c of doc.thaw) {
		assert.deepEqual(G.thaw(c.today, c.tomorrow, c.positions, c.entries, c.freezers, c.recipes, c.names).map((t) => ({ name: t.name, meal: t.meal, tomorrow: t.tomorrow })), c.expect, c.name);
	}
});

test("cook soon: only recipes listing a use-soon product, its parent or a child, most used first", () => {
	const products = [{ id: 1, name: "Milk" }, { id: 2, name: "Oat milk", parent_product_id: 1 }, { id: 3, name: "Eggs" }, { id: 4, name: "Flour" }];
	const positions = [
		{ recipe_id: 10, product_id: 2, amount: 0.5 }, { recipe_id: 10, product_id: 4, amount: 1 },
		{ recipe_id: 11, product_id: 1, amount: 1 }, { recipe_id: 11, product_id: 3, amount: 2 },
		{ recipe_id: 12, product_id: 4, amount: 3 }, { recipe_id: 13, product_id: 1, amount: 2 }
	];
	const uses = G.ingredientUses([1, 3], positions, products);
	assert.deepEqual(uses, { 10: { items: 1, amount: 0.5 }, 11: { items: 2, amount: 3 }, 13: { items: 1, amount: 2 } });
	const recipes = [10, 11, 12, 13].map((id) => ({ id, name: "R" + id }));
	const fulfillment = recipes.map((r) => ({ recipe_id: r.id, due_score: r.id === 12 ? 30 : 0, missing_products_count: 0 }));
	assert.deepEqual(G.cookSoon(recipes, fulfillment, uses).map((s) => s.recipe.id), [11, 13, 10]);
	assert.deepEqual(G.cookSoon(recipes, fulfillment, {}), []);
	assert.deepEqual(G.ingredientUses([2], positions, products)[11], { items: 1, amount: 1 });
});

test("due status tints follow the app", () => {
	assert.equal(G.tint(G.dueStatus("2026-10-03", 2, "2026-10-01")), "red");
	assert.equal(G.tint(G.dueStatus("2026-10-06", 2, "2026-10-01")), "orange");
	assert.equal(G.tint(G.dueStatus("2026-10-20", 2, "2026-10-01")), "green");
	assert.equal(G.tint(G.dueStatus("2026-09-20", 1, "2026-10-01")), "orange");
	assert.equal(G.tint(G.dueStatus(null, 1, "2026-10-01")), "gray");
	assert.equal(G.dueStatus("2026-09-28", 2, "2026-10-01").late, 3);
});

test("recipe diet verdicts and cook with swaps: shared cases", () => {
	const doc = cases("recipe-diet-cases.json");
	assert.equal(doc.rulesVersion, D.version);
	for (const c of doc.cases) {
		const m = { servings: c.servings, override: !!c.override, lines: c.lines.map((t, i) => ({ key: "free:" + i, text: t })), steps: c.steps };
		const rep = R.report(m);
		assert.equal(rep.verdict, c.expect.verdict, c.name);
		assert.equal(rep.hardBlocked, c.expect.hardBlocked, c.name);
		assert.equal(rep.summary, c.expect.summary, c.name);
		assert.deepEqual(rep.boosts, c.expect.boosts, c.name);
		for (const lang of ["en", "fr"]) {
			const v = R.swapView(m, rep, lang);
			assert.deepEqual(v.lines.map((l) => ({ key: l.key, action: l.action, text: l.text })), c.expect["lines_" + lang], c.name + " " + lang);
			assert.deepEqual(v.steps, c.expect["steps_" + lang], c.name + " " + lang);
		}
	}
});

test("linked lines read the product name and its ingredients", () => {
	const m = { servings: 2, lines: [{ key: "pos:7", productId: 3, product: "Sauce tomate maison", ingredients: "tomates, huile de colza", amount: 200, unit: "g", text: "" }], steps: [] };
	const rep = R.report(m);
	assert.equal(rep.verdict, "avoid");
	assert.equal(rep.summary, "avoid:huile colza; histamine:tomate; histamine:tomates");
	const v = R.swapView(m, rep, "en");
	assert.equal(v.lines[0].original, "200 g Sauce tomate maison");
});

test("batch spread: fridge portions within the window, freezer from day 4 with a thaw evening", () => {
	const sections = [{ id: 1, name: "Petit déjeuner" }, { id: 2, name: "Déjeuner" }, { id: 4, name: "Dîner" }];
	const names = { lunch: "Déjeuner", dinner: "Dîner" };
	const taken = [{ day: "2026-10-01", section_id: 2 }];
	const veg = R.spread("Ratatouille", [{ stockId: "a", portions: 3, inFreezer: false }, { stockId: "b", portions: 2, inFreezer: true }], "2026-10-01", sections, taken, names);
	assert.deepEqual(veg.slots.map((s) => s.day + "#" + s.sectionId + ":" + s.storage), ["2026-10-01#4:fridge", "2026-10-02#2:fridge", "2026-10-02#4:fridge", "2026-10-05#2:freezer", "2026-10-05#4:freezer"]);
	assert.equal(veg.slots[3].thawOn, "2026-10-04");
	assert.equal(veg.slots[2].histamine, false);
	const chicken = R.spread("Poulet curry", [{ stockId: "c", portions: 5, inFreezer: false }], "2026-10-01", sections, taken, names);
	assert.equal(chicken.slots.length, 3);
	assert.equal(chicken.suggestedForFreezer, 2);
	assert.equal(R.spread("Soupe", [{ stockId: "d", portions: 1, inFreezer: false }], "2026-10-01", [], [], names).slots.length, 0);
});
