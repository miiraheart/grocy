// WP4 live part: a shopping trip that teaches the store's aisles, put away with its undo, recipe to list with shares.
// Runs on the ZZ list of live-wp4b.js; the caller deletes what is in `made` and puts the store userfields back.
const assert = require("node:assert/strict");
const L = require("./live-wp4-lib.js");
const { api, ok } = L;

module.exports = async function (page, list, stores, quinoa, lentils, made, SHOTS) {
	const store = stores[0], aislesBefore = JSON.parse((await api("GET", "objects/shopping_locations/" + store.id)).userfields.al_aisles || "{}");

	// Trip: start at a store, cross 5 rows one by one, stop; the crossing order is folded into al_aisles.
	const texts = ["ZZ wp4 a", "ZZ wp4 b", "ZZ wp4 c", "ZZ wp4 d", "ZZ wp4 e"];
	for (const t of texts) await api("POST", "objects/shopping_list", { shopping_list_id: list, note: t, amount: 1 });
	await L.openList(page, list);
	await page.click(".gc-shop-trip-btn");
	await page.waitForSelector(".bootbox select");
	await page.selectOption(".bootbox select", String(store.id));
	await page.click(".bootbox .btn-primary");
	await page.waitForSelector(".gc-trip-bar", { timeout: 8000 });
	assert.ok(await page.$eval("body", (b) => b.classList.contains("gc-shop-tripping")));
	if (SHOTS) await L.shots(page, "web-trip", async () => { await L.openList(page, list); await page.waitForSelector(".gc-trip-bar"); }, SHOTS);
	await L.openList(page, list);
	for (const t of texts) {
		await page.locator(".gc-shop-row", { hasText: t }).click();
		await page.waitForTimeout(1200);
	}
	await page.click(".gc-shop-trip-btn");
	await page.waitForSelector(".gc-trip-summary", { timeout: 10000 });
	const summary = await page.textContent(".gc-trip-summary");
	assert.ok(summary.includes(store.name) && /Crossed off\s*5/.test(summary), summary);
	if (SHOTS) await page.screenshot({ path: SHOTS + "/web-trip-summary-en-1440.png" });
	const learned = JSON.parse((await api("GET", "objects/shopping_locations/" + store.id)).userfields.al_aisles);
	assert.equal(learned.trips, (aislesBefore.trips || 0) + 1);
	assert.equal(Object.keys(learned.items).filter((k) => /^t:zz wp4 [a-e]$/.test(k)).length, 5);
	ok("trip at " + store.name + ": 5 crossed, aisles learned (trips " + learned.trips + ")");
	await L.closeDialogs(page);

	// Put away: the crossed quinoa goes to stock with its defaults and leaves the list; Undo puts both back.
	for (const r of (await L.rowsOf(list)).filter((x) => /ZZ wp4 [a-e]$/.test(x.note || ""))) await api("DELETE", "objects/shopping_list/" + r.id);
	await L.openList(page, list);
	await page.locator(".gc-shop-row", { hasText: "ZZ wp4 quinoa" }).click();
	await page.waitForTimeout(1200);
	await L.openList(page, list);
	await page.click(".gc-shop-putaway");
	await page.waitForSelector(".gc-put-row");
	if (SHOTS) await L.shots(page, "web-putaway", async () => { await L.openList(page, list); await page.click(".gc-shop-putaway"); await page.waitForSelector(".gc-put-row"); }, SHOTS);
	await L.openList(page, list);
	await page.click(".gc-shop-putaway");
	await page.waitForSelector(".gc-put-row");
	const bb = await page.inputValue('.gc-put-row input[type="date"]');
	const expect = new Date(Date.parse(L.today() + "T00:00:00Z") + 30 * 864e5).toISOString().slice(0, 10);
	assert.equal(bb, expect, "best before from the product's 30 days");
	await page.click(".gc-put-go");
	await page.waitForTimeout(2500);
	assert.equal(await L.stockOf(quinoa), 3);
	assert.ok(!(await L.rowsOf(list)).some((r) => +r.product_id === quinoa));
	await page.click(".gc-ag-undo button");
	await page.waitForTimeout(2500);
	assert.equal(await L.stockOf(quinoa), 0);
	const back = (await L.rowsOf(list)).find((r) => +r.product_id === quinoa);
	assert.ok(back && +back.done === 1 && back.userfields.al_source === "suggestion");
	ok("put away 3 ZZ wp4 quinoa (best before " + bb + "), undo took the stock back and the row");

	// Recipe to list: the lentils row of 2 gets a share of 4 beside its manual 2; doing it again changes nothing.
	const recipe = +(await api("POST", "objects/recipes", { name: "ZZ wp4 dal", base_servings: 2, desired_servings: 2 })).created_object_id;
	made.recipes.push(recipe);
	await api("POST", "objects/recipes_pos", { recipe_id: recipe, product_id: lentils, amount: 4, qu_id: (await api("GET", "objects/products/" + lentils)).qu_id_stock });
	await page.goto(L.SITE + "/recipes?recipe=" + recipe, { waitUntil: "networkidle" });
	const run = () => page.evaluate(([rid, lid]) => Promise.all([GC.api("GET", "objects/recipes/" + rid), GC.api("GET", "objects/recipes_pos_resolved?query[]=recipe_id=" + rid), GC.api("GET", "objects/products"),
		GC.api("GET", "objects/quantity_units")]).then((r) => {
		const by = (l) => Object.fromEntries(l.map((x) => [x.id, x]));
		const lines = GC.recipeToList.plan(r[0], r[1], 2).filter((l) => l.ticked);
		return GC.recipeToList.apply(lines, lid, by(r[2]), by(r[3]), []).then((undo) => { window.__rtl = undo; return lines.length; });
	}), [recipe, list]);
	assert.equal(await run(), 1);
	let lr = (await L.rowsOf(list)).find((r) => +r.product_id === lentils);
	assert.equal(+lr.amount, 6);
	assert.deepEqual(JSON.parse(lr.userfields.al_recipes).map((s) => [s.recipe, s.amount]), [[recipe, 4]]);
	await run();
	lr = (await L.rowsOf(list)).find((r) => +r.product_id === lentils);
	assert.equal(+lr.amount, 6, "the same recipe again changes nothing");
	await page.evaluate(() => window.__rtl());
	assert.equal(+(await L.rowsOf(list)).find((r) => +r.product_id === lentils).amount, 6, "the second run had nothing to undo");
	await L.openList(page, list);
	assert.equal(await page.textContent(".gc-shop-row:has-text('ZZ wp4 lentilles') .gc-shop-caption"), "2 + 4 for ZZ wp4 dal");
	ok("recipe to list: 2 manual + 4 for ZZ wp4 dal on one row, captioned");
};
