// WP5 live part: the Activity page over the shared history. Undo, Redo, Inspect, Duplicate and Undo from here on the
// entries live-wp5.js wrote, plus an entry written the way the phone writes it (no web undo: Inspect and Open only).
const assert = require("node:assert/strict");
const L = require("./live-wp5-lib.js");
const { api, ok, SITE } = L;

async function openActivity(page) {
	await page.goto(SITE + "/userobjects/gc_actions", { waitUntil: "networkidle" });
	await page.waitForSelector(".gc-as-act", { timeout: 30000 });
}
async function menu(page, actionId, item) {
	const row = page.locator('.gc-as-act[data-action="' + actionId + '"]').first();
	if (!(await row.locator(".dropdown-menu.show").count())) await row.locator('[data-toggle="dropdown"]').click();
	await row.locator(".dropdown-menu.show").waitFor();
	const items = await row.locator(".dropdown-item").evaluateAll((els) => els.map((e) => e.dataset.item));
	if (!item) await row.locator('[data-toggle="dropdown"]').click();
	else {
		await row.locator('.dropdown-item[data-item="' + item + '"]').click();
		if (item !== "inspect" && item !== "undoFromHere") await page.waitForSelector('.toast-success, .toast-error, #toast-container .toast', { timeout: 30000 });
		await page.waitForTimeout(800);
	}
	return items;
}

module.exports = async function (page, before, SHOTS) {
	const ent = (await api("GET", "objects/userentities?query[]=name=gc_actions"))[0];
	const phone = (await api("POST", "objects/userobjects", { userentity_id: ent.id })).created_object_id;
	await api("PUT", "userfields/userentity-gc_actions/" + phone, { action_id: "zz-wp5-phone", created: new Date().toISOString().slice(0, 19) + "+00:00", kind: "taskComplete",
		status: "applied", origin: "ios", source: "voice", session_id: "zz-phone", summary: "ZZ wp5 phone entry", sentence: "j'ai fini", record: JSON.stringify({ v: 1, object_type: "task", object_id: "1" }) });

	await L.setting("locale", "fr");
	await openActivity(page);
	const hist = await L.history();
	assert.equal(await page.locator(".gc-as-act").count(), hist.length, "every shared entry is listed");
	assert.deepEqual(await menu(page, "zz-wp5-phone"), ["inspect", "open"], "a phone entry without web undo: Inspect and Open");
	ok("Activity lists " + hist.length + " shared entries; the phone entry offers Inspect and Open");
	if (SHOTS) await L.shots(page, "web-activity", () => openActivity(page), SHOTS);

	const addEntry = hist.find((h) => h.kind === "stockAdd" && h.status === "applied");
	await L.setting("locale", "en");
	await openActivity(page);
	const items = await menu(page, addEntry.action_id);
	assert.deepEqual(items.filter((i) => i !== "undoFromHere"), ["inspect", "undo", "duplicate", "open"]);
	await menu(page, addEntry.action_id, "undo");
	assert.equal(await L.stockOf(7), before.stock[7], "Undo took the 2 Beurre moulé back");
	assert.deepEqual(await menu(page, addEntry.action_id), ["inspect", "redo", "open"]);
	await menu(page, addEntry.action_id, "redo");
	assert.equal(await L.stockOf(7), before.stock[7] + 2, "Redo added them again");
	const redo = (await L.history()).find((h) => h.parent_id === addEntry.action_id && h.source === "redo");
	assert.ok(redo && redo.status === "applied", "the redo is a new entry pointing at the first");
	await openActivity(page);
	await menu(page, redo.action_id, "inspect");
	await page.waitForSelector(".gc-as-inspect");
	assert.ok((await page.textContent(".gc-as-inspect")).includes(redo.action_id));
	if (SHOTS) await page.screenshot({ path: SHOTS + "/web-activity-inspect-en-1440.png" });
	await L.closeDialogs(page);
	await page.evaluate(() => $(".gc-sheet-bg").remove());
	await menu(page, redo.action_id, "undo");
	assert.equal(await L.stockOf(7), before.stock[7]);
	ok("Undo, Redo (new entry with parent), Inspect and Undo again on the stock add");

	const outOf = (await L.history()).find((h) => h.kind === "listAdd" && h.status === "applied");
	await openActivity(page);
	await menu(page, outOf.action_id, "duplicate");
	const riz = async () => +((await L.listRows(1)).find((r) => +r.product_id === 22) || {}).amount;
	assert.equal(await riz(), before.riz + 2, "Duplicate put the riz on the list once more");
	const dup = (await L.history()).find((h) => h.parent_id === outOf.action_id && h.source === "duplicate");
	await openActivity(page);
	await menu(page, dup.action_id, "undo");
	assert.equal(await riz(), before.riz + 1);
	ok("Duplicate wrote a new entry, its Undo took it back");

	// Undo from here on the first entry of the EN session: every entry after it in that session, newest first.
	const tasksDone = (await L.history()).filter((h) => h.origin === "web" && (h.kind === "taskAdd" || h.kind === "taskComplete") && h.status === "applied").sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
	const first = tasksDone[0], session = first.session_id;
	const left = (await L.history()).filter((h) => h.session_id === session && h.status === "applied");
	await openActivity(page);
	assert.ok((await menu(page, first.action_id)).includes("undoFromHere"), "Undo from here offered with " + left.length + " entries: " + JSON.stringify(tasksDone.map((h) => [h.kind, h.session_id, h.created, h.status])));
	await menu(page, first.action_id, "undoFromHere");
	await page.waitForSelector(".gc-sheet .btn-primary");
	await page.click(".gc-sheet .btn-primary");
	await page.waitForFunction(() => /\d+ (undone|annulé)/.test(document.body.innerText), null, { timeout: 60000 });
	await page.waitForTimeout(1500);
	const still = (await L.history()).filter((h) => h.session_id === session && h.status === "applied");
	assert.equal(still.length, 0, "Undo from here left " + still.map((h) => h.kind).join(","));
	ok("Undo from here undid the " + left.length + " entries of the EN session (" + left.map((h) => h.kind).join(", ") + ")");

	// The rest of the run (riz on the list, the Chicken eaten) through the plain Undo of the menu.
	for (const h of (await L.history()).filter((x) => x.origin === "web" && x.status === "applied")) {
		await openActivity(page);
		await menu(page, h.action_id, "undo");
	}
	assert.equal((await L.history()).filter((x) => x.origin === "web" && x.status === "applied").length, 0);
	ok("every web entry of the run is undone from the Activity page");
};
