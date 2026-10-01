// Live check of WP4 part 1 on grocy-test: captions and the confirm card, free text in one step, the web inbox (paste,
// app entry, review across lists, applying twice), share removal in the editor, list settings, theme, passcode, organize
// and the lists menu. Everything is named "ZZ wp4", every write is undone, user settings are put back, counts must match.
// Run: NODE_PATH=<dir with playwright-core> PW_CHROMIUM=<headless shell> node custom/grocy/tests/live-wp4.js [shots dir]
const assert = require("node:assert/strict");
const L = require("./live-wp4-lib.js");
const { api, ok } = L;
const SHOTS = process.argv[2] || "";

(async () => {
	const before = await L.counts(), inboxBefore = await L.setting("al_inbox"), foldersBefore = await L.setting("al_folders");
	const made = { lists: [], recipes: [], products: [] };
	const { b, page, errors } = await L.browser();
	try {
		const list = +(await api("POST", "objects/shopping_lists", { name: "ZZ wp4 Courses" })).created_object_id;
		const market = +(await api("POST", "objects/shopping_lists", { name: "ZZ wp4 Marché" })).created_object_id;
		made.lists.push(list, market);
		const recipe = +(await api("POST", "objects/recipes", { name: "ZZ wp4 dal", base_servings: 4, desired_servings: 4 })).created_object_id;
		made.recipes.push(recipe);
		const row = +(await api("POST", "objects/shopping_list", { shopping_list_id: list, note: "ZZ wp4 quinoa", amount: 5 })).created_object_id;
		await api("PUT", "userfields/shopping_list/" + row, { al_recipes: JSON.stringify([{ recipe, amount: 2, servings: 4 }]), al_position: "1" });
		ok("set up lists " + list + ", " + market + ", recipe " + recipe + ", row " + row);

		// Caption and the confirm card (17-32): with a quantity typed she is asked, Keep current writes nothing.
		await L.openList(page, list);
		const caption = await page.textContent('.gc-shop-row[data-id="' + row + '"] .gc-shop-caption');
		assert.equal(caption, "3 + 2 for ZZ wp4 dal");
		ok("caption " + caption);
		await page.fill(".gc-shop-input", "ZZ wp4 quinoa 2");
		await page.keyboard.press("Enter");
		await page.waitForSelector(".gc-confirm", { timeout: 8000 });
		assert.ok((await page.textContent(".bootbox")).includes("5 + 2 = 7"));
		if (SHOTS) await page.screenshot({ path: SHOTS + "/confirm-card-en-1440.png" });
		await page.click(".bootbox .btn-secondary");
		await page.waitForTimeout(800);
		assert.equal(+(await api("GET", "objects/shopping_list/" + row)).amount, 5);
		ok("confirm card offers Add 5 + 2 = 7, Keep current writes nothing");
		await page.fill(".gc-shop-input", "ZZ wp4 quinoa 2");
		await page.keyboard.press("Enter");
		await page.waitForSelector(".gc-confirm", { timeout: 8000 });
		await page.click(".bootbox .btn-primary");
		await page.waitForTimeout(1000);
		assert.equal(+(await api("GET", "objects/shopping_list/" + row)).amount, 7);
		await page.fill(".gc-shop-input", "ZZ wp4 quinoa");
		await page.keyboard.press("Enter");
		await page.waitForTimeout(800);
		assert.equal(await page.$(".gc-confirm"), null, "no quantity typed: no card, the row flashes");
		ok("Add sums to 7; without a quantity the row is only flashed");

		// Free text in one step: typed text with no product is a text row, nothing else is made.
		const products = (await api("GET", "objects/products")).length;
		await page.fill(".gc-shop-input", "ZZ wp4 bougies, ZZ wp4 ficelle");
		await page.keyboard.press("Enter");
		await page.waitForTimeout(1500);
		const texts = (await L.rowsOf(list)).filter((r) => /ZZ wp4 (bougies|ficelle)/.test(r.note || "")).map((r) => r.product_id);
		assert.deepEqual(texts, [null, null]);
		assert.equal((await api("GET", "objects/products")).length, products);
		ok("two typed text items added in one step, no product made");

		// Share removal in the editor: the manual extra stays.
		await L.openList(page, list);
		await page.click('.gc-shop-row[data-id="' + row + '"] .gc-shop-edit');
		await page.waitForSelector(".gc-edit-shares");
		await page.click(".gc-edit-shares .text-danger");
		await page.waitForTimeout(1200);
		const after = await api("GET", "objects/shopping_list/" + row);
		assert.equal(+after.amount, 5);
		assert.equal(after.userfields.al_recipes || "", "");
		ok("Remove took the 2 for ZZ wp4 dal off, 5 left");

		// Inbox: an entry written as the app writes it, reviewed across two lists, applied, then applied again (no change).
		const entry = { id: "izzwp4a", text: "Salut !\nZZ wp4 Marché:\n- ZZ wp4 radis\n- 2 ZZ wp4 citrons\nZZ wp4 Courses:\nZZ wp4 quinoa 3\nmerci", source: "share",
			created: L.today() + " 10:00:00", status: "new", processed: [] };
		const doc = JSON.parse(inboxBefore || '{"v":1,"entries":[]}');
		doc.entries = (doc.entries || []).concat([entry]);
		await L.setting("al_inbox", JSON.stringify(doc));
		await L.openList(page, list);
		assert.equal(await page.textContent(".gc-shop-inbox .gc-badge"), String(doc.entries.filter((e) => e.status === "new").length));
		await page.click(".gc-shop-inbox");
		await page.waitForSelector(".gc-inbox .gc-panel-item");
		if (SHOTS) await L.shots(page, "web-inbox-panel", async () => { await L.openList(page, list); await page.click(".gc-shop-inbox"); await page.waitForSelector(".gc-inbox"); }, SHOTS);
		await L.openList(page, list);
		await page.click(".gc-shop-inbox");
		await page.waitForSelector(".gc-inbox .gc-panel-item");
		await page.click(".gc-inbox .gc-panel-item");
		await page.waitForSelector(".gc-inbox-line", { timeout: 10000 });
		const groups = await page.$$eval(".gc-inbox-review .gc-shop-banner", (h) => h.map((x) => x.textContent));
		assert.deepEqual(groups.sort(), ["ZZ wp4 Courses", "ZZ wp4 Marché"]);
		assert.ok((await page.textContent(".gc-inbox-add")).includes("3"), await page.textContent(".gc-inbox-add"));
		if (SHOTS) await L.shots(page, "web-inbox-review", async () => { await L.openList(page, list); await page.click(".gc-shop-inbox"); await page.waitForSelector(".gc-inbox .gc-panel-item"); await page.click(".gc-inbox .gc-panel-item"); await page.waitForSelector(".gc-inbox-line"); }, SHOTS);
		await page.click(".gc-inbox-add");
		await page.waitForTimeout(2500);
		const m = await L.rowsOf(market), c = await api("GET", "objects/shopping_list/" + row);
		assert.deepEqual(m.map((r) => [r.note, +r.amount]).sort(), [["ZZ wp4 citrons", 2], ["ZZ wp4 radis", 1]]);
		assert.equal(+c.amount, 8, "Add on the quinoa row: 5 + 3");
		assert.ok(m.every((r) => r.userfields.al_source === "inbox:izzwp4a"));
		const done = JSON.parse(await L.setting("al_inbox")).entries.find((e) => e.id === "izzwp4a");
		assert.equal(done.status, "done");
		assert.deepEqual(done.processed.sort((x, y) => x - y), [row].concat(m.map((r) => +r.id)).sort((x, y) => x - y));
		ok("inbox entry reviewed into two lists, quinoa summed to 8, entry done with its rows");
		const again = await page.evaluate(([t, id]) => GC.shopInbox.apply(GC.shop.inbox.plan(GC.shop.inbox.rules(t).items, id, GC.shopInbox.snapshot(GC.shopPage.state, { entries: [] })), id, GC.shopPage.state), [entry.text, entry.id]);
		assert.equal(again, null);
		assert.equal((await L.rowsOf(market)).length, 2);
		ok("applying the done entry again writes nothing");
		const pasted = await page.evaluate(() => GC.shopInbox.items("coucou, tu peux prendre du lait, 2 baguettes et le truc pour le lave vaisselle stp, merci", GC.shopPage.state));
		assert.ok(pasted.warning && pasted.items.length >= 1, "the model is out of reach here: the rules items come back with a warning");
		ok("messy text without the reader falls back to the rules with a warning");

		await require("./live-wp4-settings.js")(page, list, market, SHOTS);
	} finally {
		await b.close();
		for (const id of made.lists) {
			for (const r of await L.rowsOf(id).catch(() => [])) await api("DELETE", "objects/shopping_list/" + r.id).catch(() => null);
			await api("DELETE", "objects/shopping_lists/" + id).catch(() => null);
		}
		for (const r of await api("GET", "objects/shopping_lists")) if (/^ZZ wp4/.test(r.name)) {
			for (const x of await L.rowsOf(r.id)) await api("DELETE", "objects/shopping_list/" + x.id);
			await api("DELETE", "objects/shopping_lists/" + r.id);
		}
		for (const id of made.recipes) await api("DELETE", "objects/recipes/" + id).catch(() => null);
		await L.setting("al_inbox", inboxBefore);
		await L.setting("al_folders", foldersBefore);
	}
	assert.deepEqual(await L.counts(), before);
	assert.equal(await L.setting("al_inbox"), inboxBefore);
	ok("counts and settings back to " + JSON.stringify(before));
	if (errors.length) { console.log("page errors:", errors); process.exit(1); }
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
