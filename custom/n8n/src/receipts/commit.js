
const SECRET = "__WEBHOOK_SECRET__";
const GROCY = "http://grocy/api";
const GROCY_KEY = "__GROCY_API_KEY__";
const req = $input.first().json;
const headers = req.headers || {};
const stop = (http_status, reply) => [{ json: { http_status, reply } }];
if (headers["x-trigger-secret"] !== SECRET) return stop(401, { error: "unauthorized" });

const body = req.body || {};
const receipt = body.receipt;
if (!receipt || !Array.isArray(receipt.lines)) return stop(400, { error: "receipt.lines required" });
const applyPrices = body.apply_prices === true || body.apply_prices === "true";
const grocy = (method, path, data) => this.helpers.httpRequest({
  method, url: GROCY + path, json: true,
  headers: { "GROCY-API-KEY": GROCY_KEY, "Content-Type": "application/json" },
  ...(data === undefined ? {} : { body: data }),
});
const round2 = (v) => Math.round(v * 100) / 100;
const date = receipt.date ? String(receipt.date).slice(0, 10) : new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
const SHOPS = { "La Vie Claire": 1, Biocoop: 2, Naturalia: 3, Carrefour: 4, Monoprix: 5, "Marché": 6 };
const shopId = receipt.shopping_location_id || SHOPS[receipt.store] || null;

const entities = await grocy("GET", "/objects/userentities?query%5B%5D=" + encodeURIComponent("name=tickets"));
const entityId = entities.length ? entities[0].id : 2;
let ticketId = parseInt(receipt.ticket_id, 10) || null;
if (!ticketId) ticketId = (await grocy("POST", "/objects/userobjects", { userentity_id: entityId })).created_object_id;

const lines = receipt.lines.map((l) => ({ label: l.label, product_id: l.product_id ? parseInt(l.product_id, 10) : null, qty: l.qty,
  unit: l.unit, unit_price: l.unit_price, total: l.total, is_discount: !!l.is_discount, vat_code: l.vat_code ?? null,
  matched_by: l.product_id ? (l.matched_by || "confirmed") : null }));
const fields = (status) => ({
  store: receipt.store || "", purchased_at: date, total: receipt.total === null || receipt.total === undefined ? "" : String(receipt.total),
  currency: receipt.currency || "EUR", status, lines_json: JSON.stringify(lines), raw_ocr: body.raw_ocr || receipt.raw_ocr || "",
  parser: body.parser || receipt.parser || "manual",
});
await grocy("PUT", "/userfields/userentity-tickets/" + ticketId, fields("confirmed"));

const newAliases = {};
for (const l of lines) {
  if (!l.product_id || l.is_discount || l.matched_by === "alias") continue;
  const key = normalizeLabel(l.label).key;
  if (key) (newAliases[l.product_id] = newAliases[l.product_id] || new Set()).add(key);
}
let aliasesAdded = 0;
for (const [pid, keys] of Object.entries(newAliases)) {
  const uf = await grocy("GET", "/userfields/products/" + pid);
  const current = String(uf.receipt_aliases || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const merged = [...new Set([...current, ...keys])];
  if (merged.length !== current.length) {
    await grocy("PUT", "/userfields/products/" + pid, { receipt_aliases: merged.join("\n") });
    aliasesAdded += merged.length - current.length;
  }
}

let applied = 0;
if (applyPrices) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.product_id || l.is_discount || l.unit !== "piece" || !l.qty || l.total === null || l.total === undefined) continue;
    const next = lines[i + 1];
    const discount = next && next.is_discount ? next.total || 0 : 0;
    const price = round2((l.total + discount) / l.qty);
    if (!(price > 0)) continue;
    const entries = await grocy("GET", "/stock/products/" + l.product_id + "/entries");
    const targets = entries.filter((e) => e.purchased_date === date && !(Number(e.price) > 0));
    l.applied_entry_ids = [];
    for (const e of targets) {
      await grocy("PUT", "/stock/entry/" + e.id, {
        amount: e.amount, best_before_date: e.best_before_date, purchased_date: e.purchased_date, location_id: e.location_id,
        shopping_location_id: e.shopping_location_id || shopId, price, open: e.open, note: e.note,
      });
      l.applied_entry_ids.push(e.id);
      applied++;
    }
  }
  if (applied) await grocy("PUT", "/userfields/userentity-tickets/" + ticketId, fields("applied"));
}

const unmatched = lines.filter((l) => !l.is_discount && !l.product_id).length;
return [{ json: { http_status: 200, reply: { ticket_id: parseInt(ticketId, 10), applied, unmatched, aliases_added: aliasesAdded } } }];
