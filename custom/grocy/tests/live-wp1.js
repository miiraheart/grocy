// Live check of the WP1 web stock flows against grocy-test only, through the same API calls the companion makes.
// Run: node custom/grocy/tests/live-wp1.js   (the API key is read here from ~/.config/grocy/credentials)
// Every object it creates is named "ZZ wp1 ..." and every write is undone or deleted at the end.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const BASE = "https://grocy-test.audibox.cc/api";
if (new URL(BASE).hostname !== "grocy-test.audibox.cc") throw new Error("grocy-test only");
const creds = fs.readFileSync(path.join(os.homedir(), ".config/grocy/credentials"), "utf8");
const KEY = (/^GROCY_API_KEY=(.*)$/m.exec(creds) || [])[1].replace(/["'\s]/g, "");

function load(file) {
	const html = fs.readFileSync(path.join(__dirname, "..", "companion", file), "utf8");
	const module = { exports: {} };
	new Function("module", html.replace(/^[\s\S]*?<script>/, "").replace(/<\/script>[\s\S]*$/, ""))(module);
	return module.exports;
}
const R = load("stock-rules.js.html");

async function api(method, p, body) {
	const r = await fetch(BASE + "/" + p, { method, headers: { "GROCY-API-KEY": KEY, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const t = await r.text();
	const j = t ? JSON.parse(t) : null;
	if (!r.ok) throw new Error(method + " " + p + ": " + ((j && j.error_message) || r.status));
	return j;
}

const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString("sv-SE"); };
const today = day(0);
const tag = Math.random().toString(16).slice(2, 8);
const made = { products: [], conversions: [], tx: [] };
const ok = (msg) => console.log("ok  " + msg);

async function add(pid, body) {
	const rows = await api("POST", "stock/products/" + pid + "/add", body);
	made.tx.push(rows[0].transaction_id);
	return rows;
}
async function entries(pid) { return api("GET", "objects/stock?query[]=product_id=" + pid + "&order=id:asc"); }

async function main() {
	const d = { locations: await api("GET", "objects/locations"), groups: await api("GET", "objects/product_groups"),
		entities: await api("GET", "objects/userentities"), lists: await api("GET", "objects/shopping_lists") };
	const ids = R.resolveIds(d);
	for (const k of ["locFridge", "locFreezer", "groupDishes", "entityCuisine", "entityTickets", "shoppingList"]) assert.ok(ids[k], k + " resolved");
	assert.equal(d.locations.find((l) => l.id === ids.locFreezer).is_freezer, 1);
	ok("ids from master data " + JSON.stringify({ fridge: ids.locFridge, freezer: ids.locFreezer, dishes: ids.groupDishes, tickets: ids.entityTickets, list: ids.shoppingList }));

	const units = await api("GET", "objects/quantity_units");
	const piece = units.find((u) => /^pi/i.test(u.name)), pack = units.find((u) => /^pack/i.test(u.name));
	const raw = await api("POST", "objects/products", { name: "ZZ wp1 Crème " + tag, description: "<p>Marque Fermière</p>", location_id: ids.locFridge,
		qu_id_purchase: piece.id, qu_id_stock: piece.id, default_best_before_days: 5, default_best_before_days_after_open: 3, product_group_id: ids.groupProduce || null });
	const pid = +raw.created_object_id;
	made.products.push(pid);
	const cv = await api("POST", "objects/quantity_unit_conversions", { product_id: pid, from_qu_id: pack.id, to_qu_id: piece.id, factor: 6 });
	made.conversions.push(cv.created_object_id);
	const product = await api("GET", "objects/products/" + pid);

	const own = await api("GET", "objects/quantity_unit_conversions_resolved?query[]=product_id=" + pid);
	const conv = own.concat(await api("GET", "objects/quantity_unit_conversions"));
	assert.ok(R.unitOptions(pid, piece.id, units, conv).some((u) => u.id === pack.id), "pack offered");
	const amount = R.convert(R.parseAmount("0,5"), pack.id, piece.id, units, conv, pid);
	assert.equal(amount, 3);
	const bought = day(-4), due = R.bestBeforeFor(bought, product.default_best_before_days);
	assert.equal(due, day(1));
	let rows = await add(pid, { amount, best_before_date: due, purchased_date: bought, location_id: ids.locFridge, transaction_type: "purchase", price: 1.2 });
	const sid = rows[0].stock_id;
	await api("POST", "stock/products/" + pid + "/open", { amount, stock_entry_id: sid }).then((r) => made.tx.push(r[0].transaction_id));
	let e = (await api("GET", "objects/stock?query[]=stock_id=" + sid)).find((x) => String(x.open) === "1");
	const openedDue = R.openedDue(day(-3), product.default_best_before_days_after_open, e.best_before_date);
	assert.equal(openedDue, day(0));
	await api("PUT", "stock/entry/" + e.id, { amount: +e.amount, best_before_date: openedDue, purchased_date: e.purchased_date, location_id: +e.location_id, price: e.price, open: true, note: e.note })
		.then((r) => made.tx.push(r[0].transaction_id));
	e = (await entries(pid))[0];
	assert.deepEqual([+e.amount, e.purchased_date, e.best_before_date, String(e.open)], [3, bought, day(0), "1"]);
	ok("add 0,5 Pack = 3 Piece, bought " + bought + ", opened 3 days ago, due " + e.best_before_date);

	const pastDue = R.bestBeforeFor(day(-10), 5);
	assert.ok(R.isPast(pastDue, today));
	rows = await add(pid, { amount: 1.25, best_before_date: pastDue, purchased_date: day(-10), location_id: ids.locFridge, transaction_type: "purchase", note: "pour Léa" });
	const past = (await entries(pid)).find((x) => x.stock_id === rows[0].stock_id);
	assert.equal(past.best_before_date, pastDue);
	assert.equal(R.dueStatus(past.best_before_date, today), "expired");
	ok("past date " + pastDue + " accepted, decimal 1.25 kept, status expired");

	const parts = R.splitParts(past, 0.25, day(2), false);
	assert.ok(!parts.error);
	await api("PUT", "stock/entry/" + past.id, { amount: parts.keep, best_before_date: past.best_before_date, purchased_date: past.purchased_date, location_id: +past.location_id, price: past.price, open: false, note: past.note })
		.then((r) => made.tx.push(r[0].transaction_id));
	const p = parts.part;
	await add(pid, { amount: p.amount, best_before_date: p.best_before_date, purchased_date: p.purchased_date, location_id: p.location_id, transaction_type: "purchase", note: p.note });
	const after = await entries(pid);
	assert.deepEqual(after.map((x) => +x.amount).sort(), [0.25, 1, 3]);
	ok("split 1.25 into 1 + 0.25 with its own date " + p.best_before_date);

	const frozen = after.find((x) => +x.amount === 0.25);
	await api("POST", "stock/products/" + pid + "/transfer", { amount: 0.25, location_id_from: +frozen.location_id, location_id_to: ids.locFreezer, stock_entry_id: frozen.stock_id })
		.then((r) => made.tx.push(r[0].transaction_id));
	const moved = (await entries(pid)).find((x) => x.stock_id === frozen.stock_id);
	assert.equal(+moved.location_id, ids.locFreezer);
	ok("freeze moves the batch to the resolved freezer " + ids.locFreezer);

	const all = await api("GET", "objects/stock");
	const fields = R.productFields(product, all.filter((x) => +x.product_id === pid), Object.fromEntries(d.locations.map((l) => [l.id, l])),
		Object.fromEntries(d.groups.map((g) => [g.id, g])), { fridge: "Fridge", freezer: "Freezer" });
	for (const q of ["creme wp1", "fermiere", "lea", "congelateur", "freezer"]) assert.ok(R.matches(q, fields), q + " in " + JSON.stringify(fields));
	assert.ok(!R.matches("placard", fields));
	ok("search finds name, brand, note and places with accents folded");

	const dishName = "ZZ wp1 Curry " + tag;
	const dish = await api("POST", "objects/products", { name: dishName, product_group_id: ids.groupDishes, location_id: ids.locFreezer, qu_id_purchase: piece.id, qu_id_stock: piece.id, due_type: 2, default_best_before_days: 3 });
	made.products.push(dish.created_object_id);
	const cooked = { kind: "cooked", storage: R.storageOf(ids.kinds[ids.locFreezer]), cookedOn: day(-3), frozenOn: day(-1), link: { name: "Curry", day: day(2) }, fridgeDays: 3, freezerDays: 90 };
	assert.ok(!R.wantsEstimate(cooked));
	await add(dish.created_object_id, { amount: 2, best_before_date: R.dishDue(cooked), location_id: ids.locFreezer, transaction_type: "self-production", purchased_date: cooked.cookedOn, note: R.dishNote(cooked, "fr") });
	const de = (await entries(dish.created_object_id))[0];
	assert.deepEqual([de.best_before_date, de.note], [day(89), "congelé " + day(-1) + ", pour Curry (" + day(2) + ")"]);
	ok("dish frozen later: due " + de.best_before_date + ", note \"" + de.note + "\"");

	const rule = R.preparedRule(product, [product], 3);
	assert.deepEqual(rule, { days: 3, source: "product" });
	const prepName = R.preparedName(product.name, "fr");
	const prep = await api("POST", "objects/products", { name: prepName, product_group_id: ids.groupDishes, location_id: ids.locFridge, qu_id_purchase: piece.id, qu_id_stock: piece.id, due_type: 2, default_best_before_days: 3 });
	made.products.push(prep.created_object_id);
	const pd = { kind: "prepared", storage: "fridge", cookedOn: today, preparedDays: rule.days };
	rows = await add(prep.created_object_id, { amount: 1, best_before_date: R.dishDue(pd), location_id: ids.locFridge, transaction_type: "self-production", purchased_date: today });
	const pe = (await entries(prep.created_object_id))[0];
	await api("PUT", "userfields/stock/" + pe.stock_id, { date_manual: "1" });
	assert.equal(pe.best_before_date, day(3));
	await api("PUT", "userfields/stock/" + pe.stock_id, { date_manual: "" });
	ok("marinating \"" + prepName + "\" due " + pe.best_before_date + " (rule " + rule.source + "), date_manual set");

	for (const tx of made.tx.slice().reverse()) await api("POST", "stock/transactions/" + tx + "/undo").catch((err) => console.log("undo " + tx + ": " + err.message));
}

async function cleanup() {
	for (const id of made.products) {
		for (const e of await entries(id).catch(() => [])) await api("POST", "stock/products/" + id + "/consume", { amount: +e.amount, stock_entry_id: e.stock_id }).catch(() => null);
	}
	for (const id of made.conversions) await api("DELETE", "objects/quantity_unit_conversions/" + id).catch((err) => console.log("conv " + err.message));
	for (const id of made.products) await api("DELETE", "objects/products/" + id).catch((err) => console.log("product " + err.message));
	const left = (await api("GET", "objects/products")).filter((x) => x.name.indexOf("ZZ wp1") === 0);
	assert.equal(left.length, 0, "ZZ wp1 products left");
	ok("cleanup: " + made.products.length + " products and " + made.conversions.length + " conversion deleted, " + made.tx.length + " transactions undone");
}

let before = 0;
api("GET", "objects/stock").then((s) => { before = s.length; return main(); })
	.then(cleanup, (err) => cleanup().then(() => { throw err; }))
	.then(() => api("GET", "objects/stock")).then((s) => {
		assert.equal(s.length, before, "stock rows back to " + before);
		ok("stock rows back to " + before);
	}).catch((err) => { console.error("FAIL " + err.message); process.exitCode = 1; });
