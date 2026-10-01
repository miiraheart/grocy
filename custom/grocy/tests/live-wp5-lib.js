// Helpers of the WP5 live checks (live-wp5.js, live-wp5-activity.js): grocy-test only, keys read in the libraries.
const path = require("node:path");
const L = require("./live-wp4-lib.js");
const { api, SITE } = L;
const TWIN = path.join(__dirname, "..", "..", "n8n", "src", "recipe-import", "test", "n8n-local.mjs");

/// Answers the page's assistant-intake call with the TEST twin run on this Mac (free model, test key).
async function twinRoute(page) {
	const { loadTwin, runTwin } = await import(TWIN);
	const twin = loadTwin("assistant-intake-test.json");
	const cors = { "access-control-allow-origin": SITE, "access-control-allow-headers": "content-type, x-trigger-secret", "access-control-allow-methods": "POST, OPTIONS" };
	await page.route(/n8n\.audibox\.cc\/webhook\/assistant-intake/, async (route) => {
		if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
		const t0 = Date.now();
		let r;
		for (let tries = 1; tries <= 3; tries++) {
			r = await runTwin(twin, { headers: { "x-trigger-secret": twin.secret }, body: route.request().postDataJSON() }).response;
			if (r.status !== 502 || !/timeout|429|rate/i.test(r.body.error || "")) break;
			console.log("    twin busy (" + r.body.error + "), try " + (tries + 1));
		}
		console.log("    twin " + r.status + " in " + (Date.now() - t0) + " ms" + (r.body.model ? " on " + r.body.model : "") + (r.body.error ? ": " + r.body.error : ""));
		await route.fulfill({ status: r.status, headers: cors, contentType: "application/json", body: JSON.stringify(r.body) });
	});
}

async function openPanel(page, where) {
	await page.goto(SITE + where, { waitUntil: "networkidle" });
	await page.waitForSelector(".gc-as-pill");
	await page.evaluate(() => { GC.assist.timeoutMs = 240000; });
	await page.click(".gc-as-pill");
	await page.waitForSelector(".gc-as-panel:not([hidden]) .gc-as-form textarea");
	await page.waitForTimeout(300);
}
const newSession = (page) => page.evaluate(() => { GC.assist.session.reset(); });
const rows = (page) => page.evaluate(() => Object.values(GC.assist.session.state.rows));

/// Sends one sentence and returns the rows of that turn once the model answered (free models can take a while).
async function say(page, text) {
	const n = await page.evaluate(() => GC.assist.session.state.turns.length);
	await page.fill(".gc-as-form textarea", text);
	await page.press(".gc-as-form textarea", "Enter");
	await page.waitForFunction((k) => GC.assist.session.state.turns.length > k && !document.querySelector(".gc-as-busy"), n, { timeout: 200000 });
	return page.evaluate(() => { const s = GC.assist.session.state, t = s.turns[s.turns.length - 1]; if (t.error) throw new Error("turn error: " + t.error); return t.rows.map((id) => s.rows[id]); });
}
async function applyRow(page, rowId) {
	await page.click('.gc-as-card[data-row="' + rowId + '"] .btn-primary');
	await page.waitForFunction((id) => ["applied", "failed"].includes(GC.assist.session.state.rows[id].status), rowId, { timeout: 30000 });
	const row = await page.evaluate((id) => GC.assist.session.state.rows[id], rowId);
	if (row.status !== "applied") throw new Error(rowId + " " + row.status + " " + row.error);
	return row;
}
async function applyAll(page) {
	const drafts = (await rows(page)).filter((r) => r.status === "draft").map((r) => r.row_id);
	for (const id of drafts) await applyRow(page, id);
}

const stockOf = (pid) => L.stockOf(pid);
const listRows = (list) => api("GET", "objects/shopping_list?query[]=shopping_list_id=" + list);
async function history() {
	const ent = (await api("GET", "objects/userentities?query[]=name=gc_actions"))[0];
	const objs = await api("GET", "objects/userobjects?query[]=userentity_id=" + ent.id);
	const out = [];
	for (const o of objs) {
		const f = await api("GET", "userfields/userentity-gc_actions/" + o.id);
		out.push({ id: o.id, ...f, record: JSON.parse(f.record || "{}") });
	}
	return out;
}
async function snapshot() {
	const stock = {};
	for (const s of await api("GET", "stock")) stock[s.product_id] = +s.amount;
	const list = await listRows(1);
	return { stock, riz: +((list.find((r) => +r.product_id === 22) || {}).amount || 0), listRows: (await api("GET", "objects/shopping_list")).length,
		tasks: (await api("GET", "objects/tasks")).length, products: (await api("GET", "objects/products")).length, history: (await history()).length };
}

/// Deletes the ZZ setup rows and the history entries this run wrote.
async function cleanup(made, before) {
	const hist = (await history()).sort((a, b) => a.id - b.id);
	const mine = hist.slice(before.history);
	for (const h of mine.slice().reverse()) {
		if (!["applied", "edited"].includes(h.status) || !Array.isArray(h.record.undo)) continue;
		for (const c of h.record.undo) await api(c.method, c.path, c.body === undefined ? undefined : c.body).catch((e) => console.log("cleanup undo failed: " + e.message));
		console.log("cleanup undid " + h.kind + " " + h.summary);
	}
	for (const h of mine) await api("DELETE", "objects/userobjects/" + h.id).catch(() => {});
	for (const id of made.tasks) await api("DELETE", "objects/tasks/" + id).catch(() => {});
	for (const id of made.chores) await api("DELETE", "objects/chores/" + id).catch(() => {});

	console.log("cleanup: " + made.tasks.length + " task, " + made.chores.length + " chore, " + Math.max(0, hist.length - before.history) + " history entries deleted");
}

module.exports = { ...L, twinRoute, openPanel, newSession, rows, say, applyRow, applyAll, stockOf, listRows, history, snapshot, cleanup };
