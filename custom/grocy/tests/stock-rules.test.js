// Run: node --test custom/grocy/tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function load(file) {
	const html = fs.readFileSync(path.join(__dirname, "..", "companion", file), "utf8");
	const code = html.replace(/^[\s\S]*?<script>/, "").replace(/<\/script>[\s\S]*$/, "");
	const module = { exports: {} };
	new Function("module", code)(module);
	return module.exports;
}
const R = load("stock-rules.js.html");

test("fold drops case, accents and ligatures", () => {
	assert.equal(R.fold("Crème Fraîche"), "creme fraiche");
	assert.equal(R.fold("Œufs"), "oeufs");
});

test("search needs every word somewhere in the fields", () => {
	assert.ok(R.matches("creme frigo", ["Crème fraîche", "Réfrigérateur", "Frigo"]));
	assert.ok(R.matches("BIO", [null, "Lait", "<p>Marque Bio</p>"]));
	assert.ok(!R.matches("creme congel", ["Crème fraîche", "Réfrigérateur"]));
	assert.ok(R.matches("   ", ["x"]));
});

test("product fields cover brand, group, places with chips and notes", () => {
	const locs = { 2: { id: 2, name: "Réfrigérateur", is_freezer: 0 }, 4: { id: 4, name: "Congélateur", is_freezer: 1 } };
	const groups = { 3: { id: 3, name: "Produits laitiers et œufs" } };
	const p = { id: 9, name: "Yaourt", description: "<p>La Fermière</p>", product_group_id: 3 };
	const f = R.productFields(p, [{ location_id: 2, note: "pour Léa" }, { location_id: 4, note: null }, { location_id: 2, note: "" }], locs, groups, { fridge: "Fridge", freezer: "Freezer" });
	assert.ok(R.matches("fermiere", f));
	assert.ok(R.matches("oeufs", f));
	assert.ok(R.matches("fridge lea", f));
	assert.ok(R.matches("congelateur", f));
	assert.ok(!R.matches("placard", f));
});

test("location kinds follow is_freezer then the name", () => {
	assert.equal(R.locationKind({ name: "Réfrigérateur", is_freezer: 0 }), "fridge");
	assert.equal(R.locationKind({ name: "Fridge", is_freezer: "0" }), "fridge");
	assert.equal(R.locationKind({ name: "Cave", is_freezer: "1" }), "freezer");
	assert.equal(R.locationKind({ name: "Plan de travail", is_freezer: 0 }), "counter");
	assert.equal(R.locationKind({ name: "Placard", is_freezer: 0 }), "pantry");
	assert.equal(R.locationKind({ name: "Garage", is_freezer: 0 }), "other");
	assert.equal(R.storageOf("pantry"), "counter");
	assert.equal(R.storageOf("other"), "fridge");
});

test("ids come from master data, whatever the numbers", () => {
	const ids = R.resolveIds({
		locations: [{ id: 12, name: "Congélateur", is_freezer: 1 }, { id: 7, name: "Réfrigérateur" }, { id: 30, name: "Placard" }, { id: 8, name: "Frigo bis" }],
		groups: [{ id: 5, name: "Fruits et legumes" }, { id: 41, name: "plats cuisinés " }],
		entities: [{ id: 3, name: "tickets" }, { id: 9, name: "cuisine" }],
		lists: [{ id: 65, name: "B" }, { id: 4, name: "A" }]
	});
	assert.deepEqual([ids.locFridge, ids.locPantry, ids.locFreezer, ids.locCounter], [7, 30, 12, null]);
	assert.deepEqual([ids.groupDishes, ids.groupProduce, ids.entityCuisine, ids.entityTickets, ids.shoppingList], [41, 5, 9, 3, 4]);
	assert.equal(ids.kinds[8], "fridge");
});

test("best before follows the purchase day unless never expires", () => {
	assert.equal(R.bestBeforeFor("2026-09-20", 5), "2026-09-25");
	assert.equal(R.bestBeforeFor("2026-09-20", 0), "2026-10-04");
	assert.equal(R.bestBeforeFor("2026-09-20", -1), "2999-12-31");
	assert.equal(R.bestBeforeFor("2026-02-27", 3), "2026-03-02");
});

test("past dates are flagged, never-expires is not", () => {
	assert.ok(R.isPast("2026-09-30", "2026-10-01"));
	assert.ok(!R.isPast("2026-10-01", "2026-10-01"));
	assert.ok(!R.isPast("2999-12-31", "2026-10-01"));
	assert.equal(R.dueStatus("2026-09-30", "2026-10-01"), "expired");
	assert.equal(R.dueStatus("2026-10-02", "2026-10-01"), "urgent");
	assert.equal(R.dueStatus("2026-10-04", "2026-10-01"), "soon");
	assert.equal(R.dueStatus("2026-10-05", "2026-10-01"), "fresh");
	assert.equal(R.dueStatus("2999-12-31", "2026-10-01"), "none");
});

test("opened days count from the opened day, capped by the current date", () => {
	assert.equal(R.openedDue("2026-09-27", 4, "2026-12-01"), "2026-10-01");
	assert.equal(R.openedDue("2026-09-27", 4, "2026-09-29"), "2026-09-29");
	assert.equal(R.openedDue("2026-09-27", 4, "2999-12-31"), "2026-10-01");
	assert.equal(R.openedDue("2026-09-27", 0, "2026-12-01"), null);
});

test("units convert with product rows first, then global, inverse, kitchen factors", () => {
	const units = [{ id: 1, name: "Piece" }, { id: 2, name: "Pack" }, { id: 3, name: "g" }, { id: 4, name: "kg" }, { id: 5, name: "c.à.s." }, { id: 6, name: "ml" }, { id: 7, name: "Botte" }];
	const conv = [{ product_id: null, from_qu_id: 2, to_qu_id: 1, factor: 6 }, { product_id: 9, from_qu_id: 2, to_qu_id: 1, factor: 4 }];
	assert.equal(R.convert(1.5, 2, 1, units, conv, 9), 6);
	assert.equal(R.convert(1.5, 2, 1, units, conv, 8), 9);
	assert.equal(R.convert(3, 1, 2, units, conv, 8), 0.5);
	assert.equal(R.convert(250, 3, 4, units, conv, 9), 0.25);
	assert.equal(R.convert(2, 5, 6, units, conv, 9), 30);
	assert.equal(R.convert(1, 3, 6, units, conv, 9), null);
	assert.deepEqual(R.unitOptions(9, 1, units, conv).map((u) => u.id), [1, 2]);
	assert.deepEqual(R.unitOptions(9, 4, units, conv).map((u) => u.id), [3, 4]);
	assert.equal(R.parseAmount("0,5"), 0.5);
	assert.equal(R.parseAmount("abc"), null);
});

test("dish eat-by: custom, prepared, freezer from the freezing day, fridge, counter", () => {
	const base = { cookedOn: "2026-09-28", frozenOn: "2026-09-28", fridgeDays: 3 };
	assert.equal(R.dishDue({ ...base, storage: "fridge", custom: true, customDate: "2026-10-09" }), "2026-10-09");
	assert.equal(R.dishDue({ ...base, storage: "fridge" }), "2026-10-01");
	assert.equal(R.dishDue({ ...base, storage: "counter" }), "2026-09-29");
	assert.equal(R.dishDue({ ...base, storage: "freezer" }), "2026-12-27");
	assert.equal(R.dishDue({ ...base, storage: "freezer", frozenOn: "2026-09-30" }), "2026-12-29");
	assert.equal(R.dishDue({ ...base, storage: "freezer", frozenOn: "2026-09-20" }), "2026-12-27");
	assert.equal(R.dishDue({ ...base, kind: "prepared", storage: "fridge", preparedDays: 2 }), "2026-09-30");
});

test("dish note, estimate and histamine rules", () => {
	const d = { cookedOn: "2026-09-26", frozenOn: "2026-09-29", storage: "freezer", link: { name: "Curry", day: "2026-10-03" } };
	assert.equal(R.dishNote(d, "fr"), "congelé 2026-09-29, pour Curry (2026-10-03)");
	assert.equal(R.dishNote({ ...d, link: null }, "en"), "frozen 2026-09-29");
	assert.equal(R.dishNote({ ...d, kind: "prepared", storage: "fridge", link: { name: "Tajine", day: null } }, "en"), "for Tajine");
	assert.equal(R.dishNote({ ...d, storage: "fridge", link: null }, "en"), null);
	assert.ok(!R.wantsEstimate(d));
	assert.ok(R.wantsEstimate({ ...d, frozenOn: d.cookedOn }));
	assert.ok(!R.wantsEstimate({ ...d, storage: "fridge", kind: "prepared" }));
	assert.equal(R.histamineDays(d.cookedOn, d.frozenOn), 3);
	assert.equal(R.histamineDays("2026-09-28", "2026-09-29"), null);
});

test("prepared shelf life order: product, estimate, category, shelf, setting", () => {
	const chicken = { id: 1, name: "Poulet", product_group_id: 4, default_best_before_days_after_open: 2, default_best_before_days: 5 };
	const beef = { id: 2, name: "Boeuf", product_group_id: 4, default_best_before_days_after_open: 0, default_best_before_days: 6, userfields: {} };
	const fish = { id: 3, name: "Cabillaud", product_group_id: 4, default_best_before_days_after_open: 1, default_best_before_days: 3 };
	const tofu = { id: 4, name: "Tofu", product_group_id: 9, default_best_before_days: 10, userfields: { shelf_after_open_days: "4" } };
	const odd = { id: 5, name: "Odd", product_group_id: null, default_best_before_days: 0 };
	const cat = [chicken, beef, fish, tofu, odd];
	assert.deepEqual(R.preparedRule(chicken, cat, 3), { days: 2, source: "product" });
	assert.deepEqual(R.preparedRule(tofu, cat, 3), { days: 4, source: "estimate" });
	assert.deepEqual(R.preparedRule(beef, cat, 3), { days: 1, source: "category" });
	assert.deepEqual(R.preparedRule({ ...beef, product_group_id: 8 }, cat, 3), { days: 6, source: "shelf" });
	assert.deepEqual(R.preparedRule(odd, cat, 3), { days: 3, source: "setting" });
	assert.equal(R.preparedName("Poulet", "fr"), "Poulet en marinade");
	assert.equal(R.preparedName("Chicken", "en"), "Chicken, marinating");
	const pick = R.preparedCandidates([{ id: 1, name: "b", active: 1, product_group_id: 2 }, { id: 2, name: "A", active: "1", product_group_id: 1 }, { id: 3, name: "c", active: 0 }, { id: 4, name: "a2", active: 1 }], 1);
	assert.deepEqual(pick.map((p) => p.id), [4, 1]);
});

test("meal links: planned from today soonest first, then plain recipes", () => {
	const recipes = [{ id: 1, name: "Tajine", type: "normal" }, { id: 2, name: "Curry", type: "normal" }, { id: 3, name: "2026-40", type: "mealplan-week" }];
	const plan = [{ type: "recipe", recipe_id: 2, day: "2026-10-05" }, { type: "recipe", recipe_id: 1, day: "2026-10-02" }, { type: "recipe", recipe_id: 1, day: "2026-09-01" }, { type: "note", day: "2026-10-03" }];
	const links = R.dishLinks(recipes, plan, "2026-10-01");
	assert.deepEqual(links.map((l) => l.name + "|" + (l.day || "")), ["Tajine|2026-10-02", "Curry|2026-10-05", "Curry|", "Tajine|"]);
});

test("split keeps the rest and needs a different date or opened state", () => {
	const e = { amount: "3", best_before_date: "2026-10-10", purchased_date: "2026-09-25", open: 0, price: "2.5", location_id: "2", note: "x" };
	assert.equal(R.splitParts(e, 3, null, true).error, "amount");
	assert.equal(R.splitParts(e, 0, null, true).error, "amount");
	assert.equal(R.splitParts(e, 1, "2026-10-10", false).error, "same");
	const s = R.splitParts(e, 1.5, "2026-10-05", false);
	assert.equal(s.keep, 1.5);
	assert.deepEqual(s.part, { amount: 1.5, best_before_date: "2026-10-05", purchased_date: "2026-09-25", price: "2.5", location_id: 2, shopping_location_id: undefined, note: "x", open: false });
	assert.equal(R.splitParts(e, 1, null, true).part.best_before_date, "2026-10-10");
});
