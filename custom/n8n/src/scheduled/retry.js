const SECRET = "__WEBHOOK_SECRET__";
const GROCY = "http://grocy/api";
const GROCY_KEY = "__GROCY_API_KEY__";
const MAX_ATTEMPTS = 24;
const PER_RUN = 3;
const ARCHIVE_AFTER_DAYS = 30;
const DISH_GROUP = 1;

const grocy = (method, path, data) => this.helpers.httpRequest({
  method, url: GROCY + path, json: true,
  headers: { "GROCY-API-KEY": GROCY_KEY, "Content-Type": "application/json" },
  ...(data === undefined ? {} : { body: data }),
});
const state = $getWorkflowStaticData("global");
state.attempts = state.attempts || {};
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });

const products = await grocy("GET", "/objects/products");
const pending = products.filter((p) => p.active == 1 && p.userfields && p.userfields.shelf_status === "pending");
const report = { pending: pending.length, retried: [], archived: [] };

for (const p of pending.slice(0, PER_RUN)) {
  let reply = null;
  try {
    reply = await this.helpers.httpRequest({ method: "POST", url: "http://localhost:5678/webhook/shelf-life", json: true, timeout: 240000,
      headers: { "X-Trigger-Secret": SECRET, "Content-Type": "application/json" },
      body: { product_id: p.id, mode: "async", force: true, stock_id: "all" } });
  } catch (e) { reply = { status: "error", error: String(e.message).slice(0, 200) }; }
  const done = reply && reply.status === "done";
  if (done) delete state.attempts[p.id];
  else state.attempts[p.id] = (state.attempts[p.id] || 0) + 1;
  if (!done && state.attempts[p.id] >= MAX_ATTEMPTS) {
    await grocy("PUT", "/userfields/products/" + p.id, { shelf_status: "failed" });
    delete state.attempts[p.id];
  }
  report.retried.push({ id: p.id, name: p.name, status: reply && reply.status, source: reply && reply.source, attempts: state.attempts[p.id] || 0 });
}

if (state.lastArchive !== today) {
  state.lastArchive = today;
  const stock = await grocy("GET", "/stock");
  const inStock = new Set(stock.filter((s) => Number(s.amount) > 0).map((s) => s.product_id));
  const cutoff = Date.now() - ARCHIVE_AFTER_DAYS * 86400000;
  for (const p of products.filter((q) => q.active == 1 && q.product_group_id === DISH_GROUP && !inStock.has(q.id))) {
    const log = await grocy("GET", "/objects/stock_log?query%5B%5D=" + encodeURIComponent("product_id=" + p.id) + "&order=id%3Adesc&limit=1");
    const last = Date.parse(((log[0] && log[0].row_created_timestamp) || p.row_created_timestamp).replace(" ", "T") + "Z");
    if (last < cutoff) { await grocy("PUT", "/objects/products/" + p.id, { active: 0 }); report.archived.push(p.name); }
  }
}
return [{ json: report }];
