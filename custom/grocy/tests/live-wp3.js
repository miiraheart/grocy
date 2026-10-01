// Live check of WP3 (dashboard actions, finish cooking, plan the portions, save as variation, safe delete) against
// grocy-test only. It runs the real page code (GC.stockOne, GC.finishOps, GC.planPortions, GC.saveVariation) in a
// headless browser logged in to grocy-test, and checks the results through the API.
// Run: NODE_PATH=<dir with playwright-core> PW_CHROMIUM=<chromium or headless shell path> node custom/grocy/tests/live-wp3.js
// The API key is read here from ~/.config/grocy/credentials, the test password over ssh from keys.conf (like tools/grocy-shot.js).
// Everything it creates is named "ZZ wp3 ..."; every write is undone and every object deleted; counts must match at the end.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright-core");

const SITE = "https://grocy-test.audibox.cc", BASE = SITE + "/api";
if (new URL(BASE).hostname !== "grocy-test.audibox.cc") throw new Error("grocy-test only");
const creds = fs.readFileSync(path.join(os.homedir(), ".config/grocy/credentials"), "utf8");
const KEY = (/^GROCY_API_KEY=(.*)$/m.exec(creds) || [])[1].replace(/["'\s]/g, "");
const EXE = process["env"].PW_CHROMIUM || undefined;

async function api(method, p, body) {
	const r = await fetch(BASE + "/" + p, { method, headers: { "GROCY-API-KEY": KEY, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const t = await r.text();
	const j = t ? JSON.parse(t) : null;
	if (!r.ok) throw new Error(method + " " + p + ": " + ((j && j.error_message) || r.status));
	return j;
}
const ok = (msg) => console.log("ok  " + msg);
const today = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Paris" }).slice(0, 10);
const plusDays = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const stockOf = async (pid) => (await api("GET", "objects/stock?query[]=product_id=" + pid)).reduce((s, e) => s + +e.amount, 0);

async function counts() {
	const [p, r, m, s] = await Promise.all(["objects/products", "objects/recipes", "objects/meal_plan", "objects/stock"].map((x) => api("GET", x)));
	return { products: p.length, recipes: r.length, plan: m.length, stock: s.length };
}

async function login(page) {
	const pw = execFileSync("ssh", ["audibox", "sed -n 's/^GROCY_TEST_PASSWORD=//p' /home/miira/apps/docker/n8n-templates/keys.conf"], { encoding: "utf8" }).trim();
	await page.goto(SITE + "/login", { waitUntil: "networkidle" });
	await page.evaluate(([u, p]) => { document.querySelector("#username").value = u; document.querySelector("#password_input").value = p; }, ["miira", pw]);
	await page.click("#login-button");
	await page.waitForLoadState("networkidle");
}

(async () => {
	const before = await counts();
	const locs = await api("GET", "objects/locations"), units = await api("GET", "objects/quantity_units");
	const fridge = locs.find((l) => String(l.is_freezer) !== "1"), freezer = locs.find((l) => String(l.is_freezer) === "1");
	const made = { products: [], recipes: [], plan: [] };
	const flour = +(await api("POST", "objects/products", { name: "ZZ wp3 farine de riz", location_id: fridge.id, qu_id_purchase: units[0].id, qu_id_stock: units[0].id, active: 1 })).created_object_id;
	made.products.push(flour);
	await api("POST", "stock/products/" + flour + "/add", { amount: 5, best_before_date: plusDays(today, 30) });
	const description = "<h3>Ingrédients</h3><ul><li>200 g de beurre</li><li>1 courgette</li></ul><h3>Préparation</h3><ol><li>Faire fondre le beurre 2 minutes.</li><li>Ajouter la courgette.</li></ol>";
	const recipe = +(await api("POST", "objects/recipes", { name: "ZZ wp3 poêlée", base_servings: 2, desired_servings: 2, description })).created_object_id;
	made.recipes.push(recipe);
	await api("POST", "objects/recipes_pos", { recipe_id: recipe, product_id: flour, amount: 1, qu_id: units[0].id });
	const planId = +(await api("POST", "objects/meal_plan", { day: today, type: "recipe", recipe_id: recipe, recipe_servings: 2 })).created_object_id;
	made.plan.push(planId);
	ok("set up product " + flour + ", recipe " + recipe + ", plan entry " + planId);

	const browser = await chromium.launch({ executablePath: EXE });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	try {
		await login(page);
		await page.goto(SITE + "/recipes?recipe=" + recipe, { waitUntil: "networkidle" });
		await page.waitForSelector(".gc-kit", { timeout: 15000 });

		// Dashboard quick actions with their undo.
		for (const kind of ["use", "open", "throw"]) {
			const amountBefore = await stockOf(flour);
			const openedBefore = (await api("GET", "objects/stock?query[]=product_id=" + flour)).reduce((s, e) => s + +e.open, 0);
			await page.evaluate(([k, pid]) => GC.stockOne(k, pid, 1).then((undo) => { window.__undo = undo; }), [kind, flour]);
			if (kind === "open") assert.ok((await api("GET", "objects/stock?query[]=product_id=" + flour)).some((e) => +e.open === 1), "opened");
			else assert.equal(await stockOf(flour), amountBefore - 1, kind);
			await page.evaluate(() => window.__undo());
			assert.equal(await stockOf(flour), amountBefore, kind + " undone");
			assert.equal((await api("GET", "objects/stock?query[]=product_id=" + flour)).reduce((s, e) => s + +e.open, 0), openedBefore, kind + " open undone");
			ok(kind + " one and undo");
		}

		await page.evaluate((id) => { window.__plan = id; }, planId);
		// Finish cooking: dish created and linked, ingredient consumed, portions dated and split, plan ticked, rating; then undo.
		const res = await page.evaluate(([pid]) => GC.recipeModel(pid).then((m) => GC.finishOps(m, { servings: 2, consume: true, cuisine: true, fridge: 1, freezer: 1, eatenNow: 0,
			rating: 4, again: true, note: "zz wp3", planIds: [window.__plan] }).then((r) => { window.__finish = r; return { dishId: r.dishId, short: r.short, produced: r.produced.length }; })), [recipe]).catch((e) => { throw e; });
		assert.ok(res.dishId, "dish product");
		made.products.push(res.dishId);
		const rec = await api("GET", "objects/recipes/" + recipe);
		assert.equal(+rec.product_id, res.dishId);
		assert.equal(await stockOf(flour), 4, "ingredient consumed");
		const portions = await api("GET", "objects/stock?query[]=product_id=" + res.dishId);
		assert.equal(portions.reduce((s, e) => s + +e.amount, 0), 2, "two portions produced");
		assert.ok(portions.some((e) => +e.location_id === +freezer.id && +e.amount === 1), "one in the freezer");
		assert.ok(portions.some((e) => +e.location_id === +fridge.id && String(e.best_before_date).slice(0, 10) === plusDays(today, 3)), "fridge portion dated +3");
		assert.equal(rec.userfields.rating, "4");
		ok("finish cooking: dish " + res.dishId + ", portions placed, rating set");

		// Plan the portions on free lunches and dinners, then undo it.
		const planned = await page.evaluate(([dish]) => Promise.all([GC.api("GET", "objects/meal_plan_sections"), GC.api("GET", "objects/meal_plan?query[]=day>=" + GC.today())]).then((r) => {
			const p = GCRD.spread("ZZ wp3", window.__finish.produced.map((e) => ({ stockId: e.stock_id, portions: Math.floor(+e.amount), inFreezer: +e.location_id === GC.IDS.locFreezer })),
				GC.today(), r[0], r[1], { lunch: "Déjeuner", dinner: "Dîner" });
			return GC.planPortions(dish, p.slots).then((undo) => { window.__planUndo = undo; return p.slots.length; });
		}), [res.dishId]);
		const rows = await api("GET", "objects/meal_plan?query[]=product_id=" + res.dishId);
		assert.equal(rows.length, planned);
		assert.ok(planned >= 1, "portions planned");
		await page.evaluate(() => window.__planUndo());
		assert.equal((await api("GET", "objects/meal_plan?query[]=product_id=" + res.dishId)).length, 0);
		ok("planned " + planned + " portions and undid them");

		await page.evaluate(() => window.__finish.undo());
		assert.equal(await stockOf(flour), 5, "ingredient back");
		assert.equal(await stockOf(res.dishId), 0, "portions gone");
		const back = await api("GET", "objects/recipes/" + recipe);
		assert.ok(!back.product_id, "dish link cleared");
		assert.equal(back.userfields.rating || "", "");
		ok("finish undone");

		// Finish with the plan entry ticked, then undo restores done = 0.
		const r2 = await page.evaluate(([pid, plan]) => GC.recipeModel(pid).then((m) => GC.finishOps(m, { servings: 2, consume: false, cuisine: false, fridge: 0, freezer: 0, eatenNow: 0,
			planIds: [plan] }).then((r) => { window.__f2 = r; return true; })), [recipe, planId]);
		assert.ok(r2);
		assert.equal(String((await api("GET", "objects/meal_plan/" + planId)).done), "1");
		await page.evaluate(() => window.__f2.undo());
		assert.equal(String((await api("GET", "objects/meal_plan/" + planId)).done), "0");
		ok("plan entry ticked and unticked");

		// Save as variation writes a copy with the swaps; it is deleted again.
		await page.evaluate(([pid]) => GC.recipeModel(pid).then((m) => GC.saveVariation(m, GCRD.swapView(m, m.report, "en"))), [recipe]);
		let copy = null;
		for (let i = 0; i < 20 && !copy; i++) { await page.waitForTimeout(500); copy = (await api("GET", "objects/recipes")).find((x) => x.name === "ZZ wp3 poêlée (swaps)"); }
		assert.ok(copy, "variation saved");
		made.recipes.push(+copy.id);
		assert.ok(copy.description.includes("160 g olive oil (swap)"), copy.description);
		assert.ok(copy.description.includes("Faire fondre le olive oil 2 minutes."), "step rewritten");
		ok("variation " + copy.id + " written with the swap");

		// Safe delete: a product used in a recipe is offered the archive instead.
		await page.goto(SITE + "/products", { waitUntil: "networkidle" });
		await page.evaluate((pid) => { const b = document.querySelector('.product-delete-button[data-product-id="' + pid + '"]'); if (b) b.click(); }, flour);
		await page.waitForSelector(".bootbox", { timeout: 8000 });
		const text = await page.evaluate(() => document.querySelector(".bootbox").innerText);
		assert.ok(/archive/i.test(text) && text.includes("ZZ wp3 po"), text);
		await page.click(".bootbox .bootbox-cancel");
		ok("delete of a product used in a recipe offers archive");
	} finally {
		await browser.close();
		for (const id of made.plan) await api("DELETE", "objects/meal_plan/" + id).catch(() => null);
		for (const id of made.recipes) {
			for (const p of await api("GET", "objects/recipes_pos?query[]=recipe_id=" + id).catch(() => [])) await api("DELETE", "objects/recipes_pos/" + p.id).catch(() => null);
			await api("DELETE", "objects/recipes/" + id).catch(() => null);
		}
		for (const id of made.products) {
			const left = await stockOf(id).catch(() => 0);
			if (left > 0) await api("POST", "stock/products/" + id + "/consume", { amount: left }).catch(() => null);
			await api("DELETE", "objects/products/" + id).catch((e) => console.log("cleanup product " + id + ": " + e.message));
		}
	}
	const after = await counts();
	assert.deepEqual(after, before);
	ok("counts back to " + JSON.stringify(after));
	if (errors.length) console.log("page errors:", errors);
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
