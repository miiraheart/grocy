const GROCY = "http://grocy/api";
const GROCY_KEY = "__GROCY_API_KEY__";
const LEFTOVER_FRIDGE_DAYS = 3;

const x = $input.first().json;
if (x.reply) return [{ json: { http_status: x.http_status || 200, reply: x.reply } }];

const ctx = x.ctx;
const fr = ctx.lang === "fr";
const HISTAMINE_NOTE = fr ? "Histamine : refroidir vite, consommer de préférence sous 48 h et ne réchauffer qu'une fois."
  : "Histamine: cool quickly, best eaten within 48 h and reheat only once.";
const product = ctx.product;
const uf = product.userfields || {};
const grocy = (method, path, data) => this.helpers.httpRequest({
  method, url: GROCY + path, json: true,
  headers: { "GROCY-API-KEY": GROCY_KEY, "Content-Type": "application/json" },
  ...(data === undefined ? {} : { body: data }),
});
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
const addDays = (iso, n) => {
  const d = new Date(String(iso).slice(0, 10) + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const GROUP_BY_CATEGORY = { plat_cuisine: 1, traiteur: 1, fruit: 2, legume: 2, laitier: 3, oeufs: 3, viande: 4, volaille: 4,
  charcuterie: 4, poisson: 4, epicerie: 5, boulangerie: 5, vegetal: 5, boisson: 6, surgele: 7 };
const GROUP_NAMES = { 1: "Plats cuisinés", 2: "Fruits et légumes", 3: "Produits laitiers et œufs", 4: "Viande et poisson",
  5: "Épicerie", 6: "Boissons", 7: "Surgelés", 8: "Hygiène et maison" };
const PERISHABLE_GROUPS = [1, 3, 4];
const isDish = ctx.kind === "dish";
const dryRun = !!ctx.dry_run;

const FR_WORDS = /[àâçéèêëîïôûùœ]|\b(le|la|les|des|du|une|au|aux|et|ou|à|dans|avec|sans|jours?|conserver|consommer|frigo|réfrigérateur|congélateur|ouverture|bien|plus)\b/gi;
const EN_WORDS = /\b(the|a|an|and|or|in|with|without|days?|keep|store|eat|use|fridge|refrigerator|freezer|opening|once|within|after)\b/gi;
const inLang = (text) => {
  const t = String(text || "");
  const f = (t.match(FR_WORDS) || []).length, e = (t.match(EN_WORDS) || []).length;
  return !t.trim() || (fr ? f >= e : e >= f);
};

let r = x.result;
if (!r) {
  const keep = { shelf_status: "pending" };
  if (ctx.ingredients && !uf.ingredients) keep.ingredients = ctx.ingredients;
  if (!dryRun) await grocy("PUT", "/userfields/products/" + ctx.product_id, keep);
  const provisional = isDish ? LEFTOVER_FRIDGE_DAYS : null;
  return [{ json: { http_status: 200, reply: {
    status: "pending", fridge_days: provisional, freezer_days: null, counter_days: isDish ? 0 : null, after_open_days: null,
    confidence: null, category: ctx.group_name, due_type: isDish ? 2 : product.due_type,
    notes: isDish ? HISTAMINE_NOTE : "", risk: null, source: "none", errors: x.model_errors || [],
    elapsed_ms: Date.now() - ctx.started } } }];
}

r = { ...r };
if (!inLang(r.notes)) r.notes = "";
const fromModel = x.path === "model";
const modelFridge = fromModel ? r.fridge_days : null;
if (fromModel) {
  const caps = [x.ceiling, x.cat_max && x.cat_max[r.category]].filter(Boolean);
  for (const f of ["fridge_days", "freezer_days", "counter_days", "after_open_days"]) {
    for (const cap of caps) if (r[f] !== null && cap[f] !== null && cap[f] !== undefined) r[f] = Math.min(r[f], cap[f]);
  }
  if (x.ceiling && x.ceiling.risk === "high") r.risk = "high";
  if (r.fridge_days !== null && r.after_open_days !== null) r.after_open_days = Math.min(r.after_open_days, r.fridge_days);
}
if (isDish) {
  if (!r.fridge_days) r.fridge_days = x.ceiling ? Math.min(LEFTOVER_FRIDGE_DAYS, x.ceiling.fridge_days) : LEFTOVER_FRIDGE_DAYS;
  r.fridge_days = Math.min(r.fridge_days, LEFTOVER_FRIDGE_DAYS);
  r.counter_days = 0;
  if (!r.category || r.category === "autre") r.category = "plat_cuisine";
}
if (fromModel && modelFridge !== null && r.fridge_days !== null && r.fridge_days < modelFridge) {
  const n = r.fridge_days;
  const days = n + (fr ? (n > 1 ? " jours" : " jour") : (n > 1 ? " days" : " day"));
  const said = fr ? new RegExp("\\b(?:\\d+\\s*(?:à|-)\\s*)?" + modelFridge + "\\s*jours?\\b", "gi")
    : new RegExp("\\b(?:\\d+\\s*(?:to|-)\\s*)?" + modelFridge + "\\s*days?\\b", "gi");
  const notes = String(r.notes || "");
  const limited = fr ? ["limité à " + days + " par la table", "Limité à " + days + " par la table."]
    : ["limited to " + days + " by the table", "Limited to " + days + " by the table."];
  r.notes = said.test(notes) ? notes.replace(said, days) : notes.trim() ? notes.trim() + " (" + limited[0] + ")" : limited[1];
}
if (isDish && !/histamine/i.test(r.notes || "")) r.notes = ((r.notes || "").trim() + " " + HISTAMINE_NOTE).trim();

const groupId = product.product_group_id || GROUP_BY_CATEGORY[r.category] || null;
const dueType = isDish || PERISHABLE_GROUPS.includes(groupId) || r.risk === "high" || r.due_type === 2 ? 2 : 1;
r.due_type = x.path === "cache" ? product.due_type : dueType;

const locations = ctx.locations;
const locById = Object.fromEntries(locations.map((l) => [l.id, l]));
const daysFor = (locId) => {
  const l = locById[locId] || {};
  if (l.is_freezer == 1) return r.freezer_days;
  if (l.id === 2) return r.fridge_days;
  return r.counter_days;
};

const writes = { product: false, userfields: false, stock_updated: 0 };
if (x.path !== "cache" && !dryRun) {
  const owned = ["done", "pending", "failed"].includes(uf.shelf_status) || ctx.force;
  const canWrite = (field) => owned || !product[field];
  const native = {};
  const setNative = (field, value) => {
    if (value !== null && value !== undefined && canWrite(field) && product[field] !== value) native[field] = value;
  };
  setNative("default_best_before_days", daysFor(product.location_id));
  setNative("default_best_before_days_after_open", r.after_open_days);
  setNative("default_best_before_days_after_freezing", r.freezer_days);
  if (r.freezer_days !== null) setNative("default_best_before_days_after_thawing", isDish ? 2 : r.risk === "low" ? null : 1);
  if (!product.product_group_id && groupId) native.product_group_id = groupId;
  if (product.due_type !== r.due_type) native.due_type = r.due_type;
  if (Object.keys(native).length) { await grocy("PUT", "/objects/products/" + ctx.product_id, native); writes.product = native; }

  const s = (v) => (v === null || v === undefined ? "" : String(v));
  await grocy("PUT", "/userfields/products/" + ctx.product_id, {
    shelf_fridge_days: s(r.fridge_days), shelf_freezer_days: s(r.freezer_days), shelf_counter_days: s(r.counter_days),
    shelf_after_open_days: s(r.after_open_days), shelf_confidence: s(r.confidence), shelf_notes: s(r.notes),
    shelf_status: "done", shelf_source: r.source === "rules" ? "rules:" + r.rule_key : s(r.source), shelf_updated: today,
  });
  writes.userfields = true;
}

if (ctx.stock_id) {
  const filter = ctx.stock_id === "all" ? "product_id=" + ctx.product_id : "stock_id=" + ctx.stock_id;
  const byStockId = await grocy("GET", "/objects/stock?query%5B%5D=" + encodeURIComponent(filter));
  let rows = byStockId.length ? byStockId : [];
  if (!rows.length && /^\d+$/.test(ctx.stock_id)) {
    try { rows = [await grocy("GET", "/objects/stock/" + ctx.stock_id)]; } catch (e) { rows = []; }
  }
  if (ctx.location_id) rows = rows.filter((row) => row.location_id === ctx.location_id);
  rows = rows.filter((row) => row.product_id === ctx.product_id);
  for (const row of rows) {
    let manual = false;
    try { manual = String((await grocy("GET", "/userfields/stock/" + row.stock_id)).date_manual) === "1"; } catch (e) { manual = false; }
    if (manual) continue;
    const opened = ctx.opened || row.open == 1;
    const days = opened && r.after_open_days !== null ? r.after_open_days : daysFor(row.location_id);
    if (days === null || days === undefined) continue;
    const due = opened && r.after_open_days !== null ? addDays(row.opened_date || today, days) : addDays(row.purchased_date, days);
    if (row.best_before_date === due) continue;
    await grocy("PUT", "/stock/entry/" + row.id, {
      amount: row.amount, best_before_date: due, purchased_date: row.purchased_date, location_id: row.location_id,
      shopping_location_id: row.shopping_location_id, price: row.price, open: row.open, note: row.note,
    });
    writes.stock_updated++;
  }
}

return [{ json: { http_status: 200, reply: {
  status: "done", fridge_days: r.fridge_days, freezer_days: r.freezer_days, counter_days: r.counter_days,
  after_open_days: r.after_open_days, confidence: r.confidence, category: GROUP_NAMES[groupId] || ctx.group_name || null,
  model_category: r.category || null, due_type: r.due_type, notes: r.notes, risk: r.risk, source: r.source,
  rule_key: r.rule_key || null, cached: x.path === "cache", stock_updated: writes.stock_updated,
  product_updated: writes.product ? Object.keys(writes.product) : [], dry_run: dryRun, elapsed_ms: Date.now() - ctx.started,
} } }];
