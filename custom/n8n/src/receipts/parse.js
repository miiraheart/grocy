
const SECRET = "__WEBHOOK_SECRET__";
const req = $input.first().json;
const headers = req.headers || {};
const stop = (http_status, reply) => [{ json: { http_status, reply, needs_repair: false } }];
if (headers["x-trigger-secret"] !== SECRET) return stop(401, { error: "unauthorized" });

const body = req.body || {};
const parts = Array.isArray(body.parts) ? body.parts.filter((p) => Array.isArray(p) || typeof p === "string") : [];
const rawLines = (parts.length ? stitchParts(parts) : Array.isArray(body.lines) ? body.lines : typeof body.text === "string" ? body.text.split(/\r?\n/) : [])
  .map((l) => String(l)).filter((l) => l.trim());
if (!rawLines.length) return stop(400, { error: "lines required" });

const parsed = parseReceipt(rawLines.join("\n"));
const SHOPS = { "La Vie Claire": 1, Biocoop: 2, Naturalia: 3, Carrefour: 4, Monoprix: 5 };
const store = parsed.store || body.store_hint || null;
const receipt = {
  store, shopping_location_id: SHOPS[store] || null,
  date: parsed.date || body.date_hint || null,
  total: parsed.totals.total ?? null, subtotal: parsed.totals.subtotal ?? null, currency: "EUR",
  lines: parsed.lines.map((l) => ({ label: l.label, product_id: null, qty: l.qty, unit: l.unit, unit_price: l.unit_price,
    total: l.total, is_discount: l.is_discount, vat_code: l.vat_code, matched_by: null, flags: l.flags })),
  lines_sum: parsed.totals.lines_sum, confidence: parsed.confidence, parser: "regex-v1", raw_ocr: rawLines.join("\n"), photos: Math.max(1, parts.length),
};
const warnings = [...parsed.warnings];
if (body.image_b64) warnings.push("image_ignored: send OCR lines, the server does not read photos");
const needs_repair = parsed.warnings.some((w) => /sum_mismatch|no_total_found/.test(w)) || !parsed.lines.length;

const SYSTEM = `Tu transformes le texte OCR d'un ticket de caisse de supermarché français en lignes d'articles structurées.
Particularités des tickets français à gérer:
- Abréviations de caisse: développe-les en nom lisible (« CR.FR.EPAIS 30% » -> « Crème fraîche épaisse 30% »,
  « YT NAT » -> « Yaourt nature », « JB BLANC » -> « Jambon blanc »). Garde la marque si elle apparaît.
- Quantités: « 2 X 1,49 » ou « 2 x 1.49 € » sur la ligne suivante = quantity 2, unit_price 1.49.
- Poids: « 0,512 kg x 3,99 €/kg » = quantity 0.512, unit "kg", unit_price 3.99.
- Remises: lignes « REMISE », « REM. FIDELITE », « BON DE REDUCTION », « -0,50 » : rattache la remise à l'article
  juste au-dessus (discount positif), ne crée pas d'article.
- Consignes, sacs, cartes cadeaux: is_food = false.
- Ignore les lignes de total, TVA, paiement, carte bancaire, rendu monnaie, adresse, SIRET, horaires.
- Décimales françaises: la virgule est le séparateur décimal.
- Ne devine pas un prix illisible: mets null et baisse confidence.
- Recopie la ligne source exacte dans raw_line.
Réponds uniquement avec l'objet JSON demandé.`;
const ITEM = {
  type: "object", additionalProperties: false,
  required: ["raw_line", "name", "brand", "quantity", "unit", "unit_price", "line_total", "discount", "is_food", "category"],
  properties: {
    raw_line: { type: "string" }, name: { type: "string" }, brand: { type: ["string", "null"] }, quantity: { type: "number" },
    unit: { type: "string", enum: ["piece", "kg", "g", "l", "ml", "lot"] }, unit_price: { type: ["number", "null"] },
    line_total: { type: ["number", "null"] }, discount: { type: ["number", "null"] }, is_food: { type: "boolean" },
    category: { type: ["string", "null"] },
  },
};
const SCHEMA = {
  type: "object", additionalProperties: false, required: ["store", "purchase_date", "currency", "items", "total", "confidence"],
  properties: { store: { type: ["string", "null"] }, purchase_date: { type: ["string", "null"] }, currency: { type: "string", enum: ["EUR"] },
    total: { type: ["number", "null"] }, confidence: { type: "number" }, items: { type: "array", items: ITEM } },
};
const repair_body = {
  models: ["nvidia/nemotron-3-super-120b-a12b:free"],
  reasoning: { enabled: false }, temperature: 0, max_tokens: Math.min(4000, 60 * rawLines.length + 200),
  provider: { require_parameters: true },
  response_format: { type: "json_schema", json_schema: { name: "receipt", strict: true, schema: SCHEMA } },
  plugins: [{ id: "response-healing" }],
  messages: [{ role: "system", content: SYSTEM },
    { role: "user", content: `Enseigne probable: ${store || "inconnue"}\nLignes OCR (une par ligne, dans l'ordre):\n${rawLines.join("\n")}` }],
};
return [{ json: { receipt, warnings, needs_repair, repair_body } }];
