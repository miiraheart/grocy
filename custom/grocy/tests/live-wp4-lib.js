// Shared helpers of the WP4 live checks (live-wp4.js, live-wp4b.js): grocy-test only, keys read here and never printed.
// Run with NODE_PATH=<dir with playwright-core> PW_CHROMIUM=<chromium or headless shell path>.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright-core");

const SITE = "https://grocy-test.audibox.cc", BASE = SITE + "/api";
if (new URL(BASE).hostname !== "grocy-test.audibox.cc") throw new Error("grocy-test only");
const creds = fs.readFileSync(path.join(os.homedir(), ".config/grocy/credentials"), "utf8");
const KEY = (/^GROCY_API_KEY=(.*)$/m.exec(creds) || [])[1].replace(/["'\s]/g, "");

async function api(method, p, body) {
	const r = await fetch(BASE + "/" + p, { method, headers: { "GROCY-API-KEY": KEY, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const t = await r.text();
	const j = t ? JSON.parse(t) : null;
	if (!r.ok) throw new Error(method + " " + p + ": " + ((j && j.error_message) || r.status));
	return j;
}
const ok = (msg) => console.log("ok  " + msg);
const today = () => new Date().toLocaleString("sv-SE", { timeZone: "Europe/Paris" }).slice(0, 10);
const stockOf = async (pid) => (await api("GET", "objects/stock?query[]=product_id=" + pid)).reduce((s, e) => s + +e.amount, 0);

/// Object counts that must be the same before and after a run.
async function counts() {
	const names = ["products", "recipes", "shopping_list", "shopping_lists", "stock", "recipes_pos"];
	const r = await Promise.all(names.map((x) => api("GET", "objects/" + x)));
	return Object.fromEntries(names.map((n, i) => [n, r[i].length]));
}
async function setting(name, value) {
	if (value === undefined) return (await api("GET", "user/settings/" + name).catch(() => ({ value: null }))).value;
	return api("PUT", "user/settings/" + name, { value });
}

async function browser() {
	const pw = execFileSync("ssh", ["audibox", "sed -n 's/^GROCY_TEST_PASSWORD=//p' /home/miira/apps/docker/n8n-templates/keys.conf"], { encoding: "utf8" }).trim();
	const b = await chromium.launch({ executablePath: process["env"].PW_CHROMIUM || undefined });
	const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
	const page = await ctx.newPage();
	page.setDefaultTimeout(15000);
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("dialog", (d) => d.accept());
	await page.route(/n8n\.audibox\.cc/, (r) => r.abort());
	await page.goto(SITE + "/login", { waitUntil: "networkidle" });
	await page.evaluate(([u, p]) => { document.querySelector("#username").value = u; document.querySelector("#password_input").value = p; }, ["miira", pw]);
	await page.click("#login-button");
	await page.waitForLoadState("networkidle");
	return { b, ctx, page, errors };
}
async function openList(page, listId) {
	await page.goto(SITE + "/shoppinglist?list=" + listId, { waitUntil: "networkidle" });
	await page.waitForSelector(".gc-shop-head, .gc-shop-gate", { timeout: 15000 });
	await page.waitForTimeout(800);
}
const rowsOf = (listId) => api("GET", "objects/shopping_list?query[]=shopping_list_id=" + listId);
const closeDialogs = (page) => page.evaluate(() => { bootbox.hideAll(); $(".modal-backdrop").remove(); });

/// Screenshots in English and French at 1440 and 390 (the user locale is set back after).
async function shots(page, name, prepare, dir) {
	fs.mkdirSync(dir, { recursive: true });
	const before = await setting("locale");
	try {
		for (const lang of ["en", "fr"]) {
			await setting("locale", lang);
			for (const w of [1440, 390]) {
				await page.setViewportSize({ width: w, height: w === 390 ? 844 : 1000 });
				await prepare();
				await page.waitForTimeout(700);
				await page.screenshot({ path: path.join(dir, name + "-" + lang + "-" + w + ".png") });
				await closeDialogs(page);
			}
		}
	} finally {
		await setting("locale", before || "en");
		await page.setViewportSize({ width: 1440, height: 1000 });
	}
}

module.exports = { SITE, api, ok, today, stockOf, counts, setting, browser, openList, rowsOf, closeDialogs, shots };
