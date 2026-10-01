// Live check of WP4 part 2 on grocy-test: suggestions tray and snooze, store estimate, put away with its undo, a shopping
// trip that teaches the store's aisles, recipe to list with shares, and the stock row star as a per list favorite.
// Everything is named "ZZ wp4", every write is undone, store userfields are put back, counts must match.
// Run: NODE_PATH=<dir with playwright-core> PW_CHROMIUM=<headless shell> node custom/grocy/tests/live-wp4b.js [shots dir]
const assert = require("node:assert/strict");
const L = require("./live-wp4-lib.js");
const { api, ok } = L;
const SHOTS = process.argv[2] || "";

(async () => {
	const before = await L.counts();
	const stores = (await api("GET", "objects/shopping_locations")).slice(0, 2), storeUf = {};
	for (const s of stores) storeUf[s.id] = await api("GET", "userfields/shopping_locations/" + s.id);
	const made = { lists: [], products: [], recipes: [] };
	const { b, page, errors } = await L.browser();
	try {
		const locs = await api("GET", "objects/locations"), units = await api("GET", "objects/quantity_units");
		const fridge = locs.find((l) => String(l.is_freezer) !== "1");
		const list = +(await api("POST", "objects/shopping_lists", { name: "ZZ wp4 Trip" })).created_object_id;
		made.lists.push(list);
		const product = (name, extra) => api("POST", "objects/products", Object.assign({ name, location_id: fridge.id, qu_id_purchase: units[0].id, qu_id_stock: units[0].id, active: 1 }, extra || {}))
			.then((r) => { made.products.push(+r.created_object_id); return +r.created_object_id; });
		const quinoa = await product("ZZ wp4 quinoa", { min_stock_amount: 3, default_best_before_days: 30 });
		const lentils = await product("ZZ wp4 lentilles");
		await api("PUT", "userfields/products/" + lentils, { al_store_prices: JSON.stringify({ stores: { [stores[0].id]: { price: 2, at: L.today() }, [stores[1].id]: { price: 1.5, at: L.today() } } }) });
		await api("PUT", "userfields/shopping_lists/" + list, { al_stores: stores.map((s) => s.id).join(",") });
		ok("set up list " + list + ", products " + quinoa + ", " + lentils);

		// Suggestions: quinoa is below its minimum; snooze hides it, the undo brings it back; + adds it with the plan amount.
		await L.openList(page, list);
		await page.waitForSelector(".gc-tray-row", { timeout: 15000 });
		const names = await page.$$eval(".gc-tray-row .gc-shop-name", (n) => n.map((x) => x.textContent));
		assert.ok(names.some((n) => n.startsWith("ZZ wp4 quinoa (3")), names.join(" | "));
		assert.ok((await page.textContent(".gc-tray")).includes("below min 3"));
		if (SHOTS) await L.shots(page, "web-tray", async () => { await L.openList(page, list); await page.waitForSelector(".gc-tray-row"); }, SHOTS);
		await L.openList(page, list);
		await page.waitForSelector(".gc-tray-row");
		const row = page.locator(".gc-tray-row", { hasText: "ZZ wp4 quinoa" });
		await row.locator('button[title="Snooze for a week"]').click();
		await page.waitForTimeout(1500);
		const mem = JSON.parse((await api("GET", "objects/products/" + quinoa)).userfields.al_memory).lists[list];
		assert.equal(mem.snoozeUntil > L.today(), true);
		assert.equal(await page.locator(".gc-tray-row", { hasText: "ZZ wp4 quinoa" }).count(), 0);
		await page.click(".gc-ag-undo button");
		await page.waitForTimeout(1500);
		assert.equal(JSON.parse((await api("GET", "objects/products/" + quinoa)).userfields.al_memory).lists[list].snoozeUntil, undefined);
		ok("snooze written and undone");
		await L.openList(page, list);
		await page.locator(".gc-tray-row", { hasText: "ZZ wp4 quinoa" }).locator('button[title="Add ZZ wp4 quinoa"]').click();
		await page.waitForTimeout(1500);
		const added = (await L.rowsOf(list)).find((r) => +r.product_id === quinoa);
		assert.equal(+added.amount, 3);
		assert.equal(added.userfields.al_source, "suggestion");
		ok("suggestion added: 3 ZZ wp4 quinoa, source suggestion");

		// Store estimate over the open rows with two priced stores.
		await api("POST", "objects/shopping_list", { shopping_list_id: list, product_id: lentils, amount: 2 });
		await L.openList(page, list);
		await page.click(".gc-shop-totals.is-button");
		await page.waitForSelector(".gc-estimate-cheapest");
		const est = await page.textContent(".gc-estimate");
		assert.ok(est.includes("4.00") && est.includes("3.00") && /Cheapest split .*3\.00/.test(est), est);
		if (SHOTS) await L.shots(page, "web-estimate", async () => { await L.openList(page, list); await page.click(".gc-shop-totals.is-button"); await page.waitForSelector(".gc-estimate-cheapest"); }, SHOTS);
		ok("estimate: two stores and the cheapest split");
		await L.closeDialogs(page);

		await require("./live-wp4-trip.js")(page, list, stores, quinoa, lentils, made, SHOTS);
	} finally {
		await b.close();
		for (const id of made.lists) {
			for (const r of await L.rowsOf(id).catch(() => [])) await api("DELETE", "objects/shopping_list/" + r.id).catch(() => null);
			await api("DELETE", "objects/shopping_lists/" + id).catch(() => null);
		}
		for (const id of made.recipes) {
			for (const p of await api("GET", "objects/recipes_pos?query[]=recipe_id=" + id).catch(() => [])) await api("DELETE", "objects/recipes_pos/" + p.id).catch(() => null);
			await api("DELETE", "objects/recipes/" + id).catch(() => null);
		}
		for (const id of made.products) {
			const left = await L.stockOf(id).catch(() => 0);
			if (left > 0) await api("POST", "stock/products/" + id + "/consume", { amount: left }).catch(() => null);
			await api("DELETE", "objects/products/" + id).catch((e) => console.log("cleanup product " + id + ": " + e.message));
		}
		for (const s of stores) {
			const back = {};
			for (const k of Object.keys(storeUf[s.id] || {})) back[k] = storeUf[s.id][k] == null ? "" : storeUf[s.id][k];
			await api("PUT", "userfields/shopping_locations/" + s.id, back).catch(() => null);
		}
	}
	assert.deepEqual(await L.counts(), before);
	ok("counts back to " + JSON.stringify(before));
	if (errors.length) { console.log("page errors:", errors); process.exit(1); }
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
