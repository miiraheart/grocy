// Run: node --test custom/grocy/tests/
// The WP4 beyond rules (suggestions tray, trip cadence, store estimate, put away defaults, aisles, themes, passcode)
// ported from the app's SuggestionEngineTests, TripCadenceTests, PutAwayDefaultsTests, AisleLearnerTests,
// ThemeContrastTests and PasscodeGateTests, with the same fixtures.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const part = (file) => fs.readFileSync(path.join(__dirname, "..", "companion", file), "utf8");
function load(file) {
	const module = { exports: {} };
	new Function("module", part(file).replace(/^[\s\S]*?<script>/, "").replace(/<\/script>[\s\S]*$/, ""))(module);
	return module.exports;
}
const lib = part("shopping-lib.js.html");
const fold = new Function("return " + lib.slice(lib.indexOf("/*fold*/") + 8, lib.indexOf("/*/fold*/")))();
const B = load("shopping-beyond-rules.js.html").make(fold);
const TH = load("shopping-theme.js.html");

const TODAY = "2026-09-27";
const day = (n) => B.addDays(TODAY, n);
const product = (id, name, o = {}) => ({ id, name, active: 1, min_stock_amount: o.min, product_group_id: o.group, default_best_before_days: o.shelf,
	location_id: o.location, qu_id_purchase: o.purchase, qu_id_stock: o.stock });
const catalog = () => ({
	products: [product(41, "Lait demi-écrémé", { min: 2, group: 2 }), product(45, "Œufs", { min: 6, group: 3 }), product(46, "Riz basmati", { group: 5 }),
		product(47, "Beurre doux", { group: 2 }), product(50, "Yaourt nature", { group: 2 }), product(60, "Poulet fermier", { group: 7 }),
		product(61, "Salade batavia", { group: 2, shelf: 4 }), product(62, "Pain de mie", { purchase: 3, stock: 2 }), product(70, "Café moulu", { group: 5 })],
	groups: { 2: { id: 2, name: "Frais" }, 3: { id: 3, name: "Œufs" }, 5: { id: 5, name: "Épicerie" }, 7: { id: 7, name: "Viande et poisson" } },
	locations: [], conversions: [{ id: 1, from_qu_id: 3, to_qu_id: 2, factor: 6, product_id: 62 }]
});
const loaded = () => ({
	levels: [{ productId: 41, amount: 1 }, { productId: 46, amount: 2 }, { productId: 50, amount: 3 }],
	missing: [{ productId: 41, amount: 1 }, { productId: 45, amount: 6 }],
	expired: [{ productId: 50, day: "2026-09-22" }], overdue: [{ productId: 47, day: "2026-09-25" }],
	consumes: [{ productId: 50, amount: 2, day: "2026-09-20", spoiled: false }, { productId: 50, amount: 1, day: "2026-09-24", spoiled: true }],
	purchases: [{ productId: 41, amount: 2, day: "2026-09-18", price: 1.1, storeId: 2 }], receipts: [{ productId: 70, day: "2026-09-20" }]
});
const consumes = (pid, amounts, spoiled = []) => amounts.map((a, i) => ({ productId: pid, amount: a, day: day(-3 - i * 7), spoiled: false }))
	.concat(spoiled.map((a) => ({ productId: pid, amount: a, day: day(-5), spoiled: true })));
const purchases = (pid, offsets) => offsets.map((o) => ({ productId: pid, amount: 1, day: day(o) }));
const trips = () => purchases(46, [-2, -12, -22, -32]);
const run = (ctx, o = {}) => B.suggestions(ctx, catalog(), o.list || [], o.memory || {}, o.settings || {}, TODAY);

test("suggestions: below min, expired and overdue with their reasons", () => {
	const found = run(loaded(), { list: [{ id: 11, product_id: 45, done: 1 }, { id: 12, note: "x" }] });
	assert.ok(!found.some((s) => s.productId === 45), "eggs on the list, even crossed");
	assert.equal(found[0].productId, 41);
	assert.equal(B.reasonText(found[0].reasons[0], "en", TODAY), "below min 2");
	assert.equal(B.reasonText(found[0].reasons[0], "fr", TODAY), "sous le minimum 2");
	const all = run(loaded());
	assert.deepEqual(all.map((s) => s.productId), [41, 45, 50, 47]);
	const yogurt = all.find((s) => s.productId === 50);
	assert.equal(B.reasonText(yogurt.reasons[0], "en", TODAY), "expired Tue");
	assert.equal(B.reasonText(yogurt.reasons[0], "fr", TODAY), "périmé mar.");
	assert.equal(B.reasonText(all.find((s) => s.productId === 47).reasons[0], "en", TODAY), "due Fri");
});

test("suggestions: sources switch off, snoozes hide until their day", () => {
	assert.deepEqual(run(loaded(), { settings: { sources: ["expired"] } }).map((s) => s.productId), [50, 47]);
	assert.deepEqual(run(loaded(), { settings: { sources: ["belowMin"] } }).map((s) => s.productId), [41, 45]);
	assert.equal(run(loaded(), { settings: { sources: [] } }).length, 0);
	assert.ok(!run(loaded(), { memory: { snoozeUntil: { 41: day(7) } } }).some((s) => s.productId === 41));
	assert.ok(run(loaded(), { memory: { snoozeUntil: { 41: day(0) } } }).some((s) => s.productId === 41));
});

test("suggestions: run out prediction against the next trip", () => {
	const ctx = { levels: [{ productId: 50, amount: 3 }], consumes: consumes(50, [30, 30, 30], [300]), purchases: trips() };
	const y = run(ctx).find((s) => s.productId === 50);
	assert.deepEqual(y.reasons[0], { kind: "predicted", cover: 3, trip: 8 });
	assert.equal(B.reasonText(y.reasons[0], "en", TODAY), "runs out in 3 days, next trip in 8");
	ctx.levels[0].amount = 12;
	assert.equal(run(ctx).length, 0);
	const c2 = { consumes: consumes(50, [30, 30], [30, 30]) };
	assert.equal(B.rate(50, c2, TODAY), null);
	c2.consumes.push({ productId: 50, amount: 30, day: day(-95), spoiled: false });
	assert.equal(B.rate(50, c2, TODAY), null);
	c2.consumes.push({ productId: 50, amount: 30, day: day(-40), spoiled: false });
	assert.equal(B.rate(50, c2, TODAY).perDay, 1);
});

test("suggestions: usuals, amounts, proteins and the spoil warning", () => {
	const ctx = { purchases: purchases(70, [-19, -31]), receipts: [{ productId: 70, day: day(-43) }] };
	const coffee = run(ctx).find((s) => s.productId === 70);
	assert.deepEqual(coffee.reasons[0], { kind: "usual", every: 12, lastAgo: 19 });
	assert.equal(B.reasonText(coffee.reasons[0], "en", TODAY), "usually every 12 days, last 19 days ago");
	assert.equal(run({ purchases: purchases(70, [-19, -31]) }).length, 0);
	assert.equal(run({ purchases: purchases(70, [-5, -17, -29]) }).length, 0);
	const amounts = run({ purchases: trips(), consumes: consumes(61, [30, 30, 30]).concat(consumes(62, [30, 30, 30])), levels: [{ productId: 62, amount: 3 }] });
	assert.equal(amounts.find((s) => s.productId === 61).amount, 4);
	const bread = amounts.find((s) => s.productId === 62);
	assert.equal(bread.amount, 3); assert.equal(bread.unitId, 3);
	const chicken = { purchases: trips(), consumes: consumes(60, [30, 30, 30]) };
	assert.equal(run(chicken).find((s) => s.productId === 60).amount, 1);
	assert.equal(run(chicken, { memory: { freezer: { 60: true } } }).find((s) => s.productId === 60).amount, 18);
	const spoil = run({ purchases: trips(), consumes: consumes(50, [35, 35, 35], [45]) }).find((s) => s.productId === 50);
	assert.equal(B.warning(spoil, "en"), "you threw away 30 % last time");
	assert.equal(B.warning(spoil, "fr"), "30 % jeté la dernière fois");
});

test("trip cadence", () => {
	const ctx = { purchases: purchases(41, [-2, -12, -22, -32]).concat(purchases(46, [-12, -22])) };
	assert.equal(B.gap(ctx, TODAY), 10); assert.equal(B.nextTrip(ctx, TODAY), 8);
	assert.equal(B.gap({ purchases: purchases(41, [-1, -5, -200]), receipts: [{ productId: 41, day: day(-13) }] }, TODAY), 6);
	assert.equal(B.gap({}, TODAY), 10); assert.equal(B.nextTrip({}, TODAY), 10);
	assert.equal(B.gap({ purchases: purchases(41, [-2, -12, -22]) }, TODAY, 7), 7);
	assert.equal(B.nextTrip({ purchases: purchases(41, [-2, -12, -22]) }, TODAY, 7), 5);
	assert.equal(B.nextTrip({ purchases: purchases(41, [-15, -25, -35]) }, TODAY), 1);
});

test("store estimate and cheapest split", () => {
	const products = { 41: { id: 41, userfields: { al_store_prices: JSON.stringify({ stores: { 1: { price: 2, at: "2026-09-01" }, 2: { price: 1.5, at: "2026-09-02" } } }) } },
		46: { id: 46, userfields: { al_store_prices: JSON.stringify({ stores: { 1: { price: 3, at: "2026-09-01" } } }) } } };
	const rows = [{ id: 1, product_id: 41, amount: 2, done: 0 }, { id: 2, product_id: 46, amount: 1, done: 0, userfields: { al_price_qty: "2" } }, { id: 3, product_id: 41, amount: 9, done: 1 }];
	const e = B.estimate(rows, { purchases: [{ productId: 41, day: "2026-09-20", price: 1.2, storeId: 1 }] }, products, [1, 2]);
	assert.deepEqual(e.stores.map((s) => [s.storeId, s.total, s.missing]), [[1, 8.4, 0], [2, 3, 1]]);
	assert.equal(e.cheapest, 8.4);
	assert.equal(B.estimate(rows, {}, products, [1]), null);
});

test("put away defaults", () => {
	const cat = { products: [{ id: 41, name: "Lait", product_group_id: 2, location_id: 3, shopping_location_id: 2, default_best_before_days: 7 },
		{ id: 70, name: "Saumon", product_group_id: 7, location_id: 3, default_best_before_days: 2, default_best_before_days_after_freezing: 90 }, { id: 71, name: "Sel", product_group_id: 5 }],
	groups: { 2: { name: "Frais" }, 5: { name: "Épicerie" }, 7: { name: "Viande et poisson" } }, locations: [{ id: 3, name: "Frigo", is_freezer: 0 }, { id: 4, name: "Congélateur", is_freezer: 1 }] };
	const row = (id, pid, price, stores) => ({ id, product_id: pid, amount: 2, done: 1, userfields: { al_price: price == null ? "" : String(price), al_stores: (stores || []).join(",") } });
	const today = "2026-09-29";
	let l = B.putAwayLine(row(2, 41, 1.5, [2]), cat, null, null, today);
	assert.deepEqual([l.price, l.priceSource, l.storeId, l.locationId, l.bestBefore], [1.5, "row", 2, 3, "2026-10-06"]);
	l = B.putAwayLine(row(3, 41), cat, null, null, today);
	assert.deepEqual([l.storeId, l.price, l.priceSource], [2, null, "none"]);
	l = B.putAwayLine(row(3, 41), cat, 1, { purchases: [{ productId: 41, day: "2026-09-10", price: 1.3, storeId: 1 }] }, today);
	assert.deepEqual([l.storeId, l.price, l.priceSource], [1, 1.3, "store"]);
	assert.equal(B.putAwayLine(row(4, 71), cat, null, null, today).bestBefore, "2999-12-31");
	const salmon = B.putAwayLine(row(5, 70), cat, null, null, today);
	assert.deepEqual([salmon.freshProtein, salmon.locationId, salmon.bestBefore], [true, 4, "2026-12-28"]);
	const soon = B.cookSoon(salmon, cat.products[1], cat.locations, today);
	assert.deepEqual([soon.locationId, soon.bestBefore, soon.cookSoon], [3, "2026-09-30", true]);
	assert.ok(B.putAwayLine({ id: 6, note: "bougies", amount: 1, userfields: {} }, cat, null, null, today).skip);
});

test("aisles: moving average and learned category order", () => {
	const steps = [{ cat: "b:produce", item: "t:apple" }, { cat: "b:dairy", item: "t:milk" }];
	const one = B.learn(steps, {});
	assert.deepEqual([one.trips, one.cats["b:produce"], one.cats["b:dairy"]], [1, 0, 1]);
	assert.equal(B.learn(steps, one).trips, 2);
	const cats = [{ id: "c1", name: "Produce", builtin: "produce" }, { id: "c2", name: "Dairy", builtin: "dairy" }, { id: "c3", name: "Pantry", builtin: "pantry" }];
	assert.deepEqual(B.categoryOrder(cats, { trips: 2, cats: { "b:dairy": 0.1, "b:produce": 0.9 } }).map((c) => c.id), ["c2", "c1", "c3"]);
	assert.deepEqual(B.categoryOrder(cats, { trips: 1, cats: { "b:dairy": 0.1 } }).map((c) => c.id), ["c1", "c2", "c3"]);
	assert.deepEqual(B.categoryOrder(cats, { trips: 3, useLearned: false, cats: { "b:dairy": 0.1 } }).map((c) => c.id), ["c1", "c2", "c3"]);
	const crossed = ["a", "b", "c", "d"].map((x, i) => ({ cat: "n:x", item: "t:" + x, at: "2026-09-29 10:0" + i + ":00" }));
	assert.equal(B.crossedSteps(crossed, "2026-09-29 09:00:00"), null, "fewer than 5 is not a walk");
	crossed.push({ cat: "n:y", item: "t:e", at: "2026-09-29 10:09:00" }, { cat: "n:y", item: "t:old", at: "2026-09-28 10:00:00" });
	assert.equal(B.crossedSteps(crossed, "2026-09-29 09:00:00").length, 5);
});

test("themes: grocy default, AnyList opt in, contrast and passcode", async () => {
	assert.equal(TH.read(null).id, "basic.grocy");
	assert.ok(TH.read({ id: "basic.nope" }).soft);
	assert.deepEqual(TH.OFFERED.map((t) => t.id).slice(0, 3), ["basic.grocy", "basic.aqua", "basic.purple"]);
	assert.equal(TH.OFFERED.length, 10);
	for (const t of TH.ANYLIST) { assert.ok(TH.contrast(t.light, "#FFFFFF") >= 4.5, t.id); assert.ok(TH.contrast(t.dark, "#FFFFFF") >= 4.5, t.id); }
	assert.equal(TH.style({ id: "basic.aqua" }, true)["--gc-shop-banner"], "#0F5E85");
	assert.deepEqual(TH.problems({ banner: "#FFFF00", bannerText: "#FFFFFF" }), ["banner"]);
	assert.deepEqual(TH.problems({ banner: "#147BAE", text: "#EEEEEE" }), ["text"]);
	assert.deepEqual(TH.problems({ banner: "#147BAE" }), []);
	const salt = TH.salt((a) => crypto.getRandomValues(a));
	const stored = await TH.hash("1234", salt, crypto.webcrypto.subtle);
	assert.match(stored, /^sha256:[0-9a-f]{16}:[0-9a-f]{64}$/);
	assert.equal(stored.split(":")[2], crypto.createHash("sha256").update(salt + "1234").digest("hex"), "same hash as CryptoKit (salt then code)");
	assert.equal(await TH.matches("1234", stored, crypto.webcrypto.subtle), true);
	assert.equal(await TH.matches("0000", stored, crypto.webcrypto.subtle), false);
});
