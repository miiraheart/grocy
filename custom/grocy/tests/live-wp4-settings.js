// WP4 live part: list settings, themes, passcode gate, organize and the lists menu, on the ZZ lists of live-wp4.js
// (deleted with them); al_folders is put back by the caller.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const L = require("./live-wp4-lib.js");
const { api, ok } = L;

module.exports = async function (page, list, market, SHOTS) {
	const uf = async (id) => (await api("GET", "objects/shopping_lists/" + id)).userfields;

	// List Settings: the grocy theme by default, an AnyList theme on a click, settings written one field at a time.
	await L.openList(page, list);
	const soft = await page.$eval(".gc-shop-page", (el) => el.style.getPropertyValue("--gc-shop-banner"));
	assert.equal(soft, "var(--g-accent-soft)", "grocy theme by default");
	await page.click('[data-panel="settings"]');
	await page.waitForSelector(".gc-list-settings");
	if (SHOTS) await L.shots(page, "web-list-settings", async () => { await L.openList(page, list); await page.click('[data-panel="settings"]'); await page.waitForSelector(".gc-list-settings"); }, SHOTS);
	await L.openList(page, list);
	await page.click('[data-panel="settings"]');
	await page.waitForSelector(".gc-list-settings");
	await page.click('.gc-theme-swatch[title="Aqua"]');
	await page.click('.gc-list-settings input[type="checkbox"] >> nth=1');
	await page.click(".bootbox .btn-primary");
	await page.waitForTimeout(1500);
	let u = await uf(list);
	assert.equal(JSON.parse(u.al_theme).id, "basic.aqua");
	assert.equal(u.al_hide_crossed, "on");
	const aqua = await page.$eval(".gc-shop-page", (el) => el.style.getPropertyValue("--gc-shop-banner"));
	assert.ok(/#147BAE|#0F5E85/i.test(aqua), aqua);
	ok("theme Aqua and Hide crossed written, the banner follows");

	// Passcode: stored as sha256:<salt>:<hex>, the list asks for it, a wrong code is refused.
	const salt = crypto.randomBytes(8).toString("hex");
	await api("PUT", "userfields/shopping_lists/" + list, { al_passcode: "sha256:" + salt + ":" + crypto.createHash("sha256").update(salt + "4321").digest("hex") });
	await L.openList(page, list);
	await page.waitForSelector(".gc-shop-gate");
	if (SHOTS) await L.shots(page, "web-passcode", async () => { await L.openList(page, list); await page.waitForSelector(".gc-shop-gate"); }, SHOTS);
	await L.openList(page, list);
	await page.fill(".gc-pass-input", "1111");
	await page.waitForTimeout(500);
	assert.ok(await page.$(".gc-shop-gate"), "wrong code keeps the gate");
	await page.fill(".gc-pass-input", "4321");
	await page.waitForSelector(".gc-shop-rows, .gc-shop-empty", { timeout: 8000 });
	assert.equal(await page.$(".gc-shop-gate"), null);
	ok("passcode gate: wrong code refused, the right one opens the list");
	await page.click('[data-panel="settings"]');
	await page.waitForSelector(".gc-list-settings");
	await page.click('.gc-list-tools button:has-text("Turn Passcode Off")');
	await page.waitForTimeout(1200);
	assert.equal((await uf(list)).al_passcode || "", "");
	ok("passcode turned off");

	// Organize: a first edit seeds the 19 built ins and her groups, a category is added, the default stays Other.
	await L.openList(page, market);
	await page.click('[data-panel="organize"]');
	await page.waitForSelector(".gc-organize");
	if (SHOTS) await L.shots(page, "web-organize", async () => { await L.openList(page, market); await page.click('[data-panel="organize"]'); await page.waitForSelector(".gc-organize"); }, SHOTS);
	await L.openList(page, market);
	await page.click('[data-panel="organize"]');
	await page.waitForSelector(".gc-organize");
	await page.fill('.gc-organize input[placeholder="Category name"]', "ZZ wp4 vrac");
	await page.click('.gc-organize button:has-text("Add Category")');
	await page.waitForTimeout(2000);
	const cats = JSON.parse((await uf(market)).al_categories);
	assert.equal(cats["default"], "c:other");
	assert.ok(cats.sets[0].cats.length >= 20 && cats.sets[0].cats.some((c) => c.name === "ZZ wp4 vrac"));
	ok("organize seeded " + cats.sets[0].cats.length + " categories with ZZ wp4 vrac");
	await L.closeDialogs(page);

	// Lists menu: a folder is made and the market list moved into it, then the pane shows the folder.
	await L.openList(page, list);
	await page.evaluate(() => GC.shopListsEdit.open(GC.shopPage.state));
	await page.waitForSelector(".gc-lists-edit");
	await page.fill('.gc-lists-edit input[placeholder="Folder name"]', "ZZ wp4 dossier");
	await page.click('.gc-lists-edit button:has-text("New folder")');
	await page.waitForTimeout(1500);
	const folder = JSON.parse(await L.setting("al_folders")).folders.find((f) => f.name === "ZZ wp4 dossier");
	assert.ok(folder);
	await api("PUT", "userfields/shopping_lists/" + market, { al_folder: folder.id });
	await L.openList(page, list);
	assert.ok((await page.textContent(".gc-shop-pane")).includes("ZZ wp4 dossier"));
	if (SHOTS) await L.shots(page, "web-lists-edit", async () => { await L.openList(page, list); await page.evaluate(() => GC.shopListsEdit.open(GC.shopPage.state)); await page.waitForSelector(".gc-lists-edit"); }, SHOTS);
	ok("folder ZZ wp4 dossier made and shown in the pane");
};
