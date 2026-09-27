const SECRET = "__WEBHOOK_SECRET__";
const GROCY = "http://grocy/api";
const GROCY_KEY = "__GROCY_API_KEY__";
const TABLE = /*@RULES@*/null;
const NOTES_EN = /*@NOTES_EN@*/null;
const started = Date.now();

const req = $input.first().json;
const headers = req.headers || {};
const stop = (http_status, reply) => [{ json: { http_status, reply, needs_model: false } }];
if (headers["x-trigger-secret"] !== SECRET) return stop(401, { status: "failed", error: "unauthorized" });

const body = req.body || {};
const PROVIDERS = ["openrouter", "groq", "mistral", "gemini", "ollama"];
const provider = PROVIDERS.includes(body.provider) ? body.provider : null;
const instructions = typeof body.instructions === "string"
  ? body.instructions.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, 500) : "";
const productId = parseInt(body.product_id, 10) || 0;
const dryRun = !productId;
if (dryRun && !String(body.name || "").trim()) return stop(400, { status: "failed", error: "product_id or name required" });

const grocy = (method, path, data) => this.helpers.httpRequest({
  method, url: GROCY + path, json: true,
  headers: { "GROCY-API-KEY": GROCY_KEY, "Content-Type": "application/json" },
  ...(data === undefined ? {} : { body: data }),
});

let product;
if (dryRun) product = { id: 0, name: String(body.name).trim(), location_id: body.location_id ? parseInt(body.location_id, 10) : null,
  product_group_id: null, due_type: 1, description: "", userfields: {} };
else {
  try { product = await grocy("GET", "/objects/products/" + productId); }
  catch (e) { return stop(404, { status: "failed", error: "product not found" }); }
}
const uf = product.userfields || {};
let lang = "fr";
try { lang = String((await grocy("GET", "/user/settings/locale")).value || "fr").slice(0, 2).toLowerCase(); } catch (e) { lang = "fr"; }
if (!["en", "fr"].includes(lang)) lang = "en";
const locations = await grocy("GET", "/objects/locations");
const groups = await grocy("GET", "/objects/product_groups");
const loc = locations.find((l) => l.id === product.location_id) || {};
const group = groups.find((g) => g.id === product.product_group_id) || null;

const GROUP_IDS = { dish: 1, produce: 2 };
const kind = ["dish", "product", "produce"].includes(body.kind) ? body.kind
  : product.product_group_id === GROUP_IDS.dish ? "dish"
  : product.product_group_id === GROUP_IDS.produce ? "produce" : "product";
const storageOf = (l) => (l.is_freezer == 1 ? "freezer" : l.id === 2 ? "fridge" : "counter");
const storage = ["fridge", "freezer", "counter"].includes(body.storage) ? body.storage : storageOf(loc);
const name = String(body.name || product.name).replace(/\b\d+(?:[.,]\d+)?\s*(?:g|gr|kg|cl|ml|l|x)\b|\bx\s?\d+\b/gi, " ").replace(/\s+/g, " ").trim();
const ingredients = String(body.ingredients || uf.ingredients || "").trim();

const ctx = {
  product_id: productId, name, product_name: product.name, ingredients, kind, storage, lang,
  opened: body.opened === true || body.opened === 1 || body.opened === "true",
  stock_id: body.stock_id && !dryRun ? String(body.stock_id) : null,
  location_id: body.location_id ? parseInt(body.location_id, 10) : null,
  mode: body.mode === "async" ? "async" : "sync",
  force: body.force === true || body.force === "true", dry_run: dryRun,
  provider, provider_only: dryRun && !!provider, instructions,
  product, locations, group_name: group ? group.name : null, started,
};

const int = (v) => (v === null || v === undefined || v === "" ? null : parseInt(v, 10));
const updatedDaysAgo = uf.shelf_updated ? (Date.now() - Date.parse(uf.shelf_updated)) / 86400000 : 9999;
const cachedOk = uf.shelf_status === "manual" || (uf.shelf_status === "done" && updatedDaysAgo <= 180);
if (cachedOk && !ctx.force && !dryRun && !provider && !instructions) {
  const cached = {
    fridge_days: int(uf.shelf_fridge_days), freezer_days: int(uf.shelf_freezer_days),
    counter_days: int(uf.shelf_counter_days), after_open_days: int(uf.shelf_after_open_days),
    confidence: uf.shelf_confidence === null ? null : Number(uf.shelf_confidence),
    category: null, due_type: product.due_type, notes: uf.shelf_notes || "", risk: null,
    source: uf.shelf_source || uf.shelf_status,
  };
  return [{ json: { ctx, needs_model: false, path: "cache", result: cached } }];
}

const norm = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/œ/g, "oe").replace(/æ/g, "ae").replace(/[’`]/g, "'").replace(/[^a-z0-9' -]/g, " ").replace(/\s+/g, " ").trim();
const index = [];
for (const it of TABLE.items) for (const a of [it.name, ...it.aliases]) index.push({ alias: norm(a), item: it });
const byKey = Object.fromEntries(TABLE.items.map((it) => [it.key, it]));

function matchRule(text) {
  const n = " " + norm(text) + " ";
  const hits = [];
  for (const { alias, item } of index) {
    const i = n.indexOf(" " + alias + " ");
    if (i >= 0) hits.push({ pos: i, len: alias.length, key: item.key, item });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.pos - b.pos || b.len - a.len);
  const top = hits[0];
  const outside = hits.filter((h) => h.key !== top.key && (h.pos < top.pos || h.pos + h.len > top.pos + top.len));
  return { item: top.item, confident: outside.length === 0, candidates: [...new Set(hits.map((h) => h.key))] };
}

const CAT_MAX = {};
for (const it of TABLE.items) {
  const m = (CAT_MAX[it.category] = CAT_MAX[it.category] || {});
  for (const f of ["fridge_days", "freezer_days", "counter_days", "after_open_days"])
    if (it[f] !== null) m[f] = Math.max(m[f] ?? 0, it[f]);
}

const INGREDIENT_RULES = [
  [/\briz\b|\bsushi/, "riz_cuit"],
  [/\bpoissons?\b|saumon|thon|cabillaud|colin|merlu|sardine|maquereau|crevette|moule|fruits de mer|calamar|truite/, "poisson_cuit"],
  [/oeufs? crus?|mayonnaise maison|tiramisu|mousse au chocolat/, "preparation_oeufs_crus"],
  [/\boeufs?\b/, "plat_oeufs"],
  [/\bpates\b|spaghetti|tagliatelle|nouilles|gnocchi|lasagne|ravioli/, "pates_cuites"],
  [/\bboeuf\b|\bporc\b|poulet|volaille|agneau|\bveau\b|dinde|canard|viande|lardons|jambon|saucisse/, "restes_viande"],
  [/lentilles|pois chiches|haricots (rouges|blancs|secs)|flageolets/, "legumineuses_cuites"],
];

const nameHit = matchRule(name);
const itemView = (it) => it && ({ key: it.key, category: it.category, fridge_days: it.fridge_days, freezer_days: it.freezer_days,
  counter_days: it.counter_days, after_open_days: it.after_open_days, risk: it.risk, due_type: it.due_type, notes: it.notes });
const ruleResult = (it, extra = {}) => ({
  fridge_days: it.fridge_days, freezer_days: it.freezer_days, counter_days: it.counter_days,
  after_open_days: it.after_open_days, confidence: 0.9, category: it.category, due_type: it.due_type,
  notes: (lang === "fr" ? it.notes : NOTES_EN[it.key]) || "", risk: it.risk, source: "rules", rule_key: it.key, ...extra,
});

let ceiling = null;
let hint = nameHit ? itemView(nameHit.item) : null;
let needsModel = true;
let result = null;

if (kind === "dish") {
  const dishItems = [];
  if (nameHit && ["plat_cuisine", "traiteur"].includes(nameHit.item.category)) dishItems.push(nameHit.item);
  const ing = norm(name + " " + ingredients);
  for (const [re, key] of INGREDIENT_RULES) if (re.test(ing)) dishItems.push(byKey[key]);
  const minOf = (f, dflt) => {
    const vals = dishItems.map((it) => it[f]).filter((v) => v !== null && v !== undefined);
    return vals.length ? Math.min(...vals) : dflt;
  };
  ceiling = { fridge_days: Math.min(3, minOf("fridge_days", 3)), freezer_days: minOf("freezer_days", 90), counter_days: 0, after_open_days: null,
    risk: dishItems.some((it) => it.risk === "high") ? "high" : null, keys: dishItems.map((it) => it.key) };
  if (!hint && dishItems.length) hint = itemView(dishItems[0]);
  if (!ingredients && nameHit && nameHit.confident && dishItems.length) {
    needsModel = false;
    result = ruleResult(nameHit.item, { fridge_days: ceiling.fridge_days, freezer_days: nameHit.item.freezer_days === null ? null : Math.min(nameHit.item.freezer_days, ceiling.freezer_days),
      risk: ceiling.risk || nameHit.item.risk });
  }
} else if (nameHit) {
  const it = nameHit.item;
  ceiling = { fridge_days: it.fridge_days, freezer_days: it.freezer_days, counter_days: it.counter_days, after_open_days: it.after_open_days, risk: it.risk, keys: [it.key] };
  const wanted = { fridge: it.fridge_days ?? it.after_open_days, freezer: it.freezer_days, counter: it.counter_days }[storage];
  if (nameHit.confident && wanted !== null && wanted !== undefined) { needsModel = false; result = ruleResult(it); }
}

if (!needsModel && !provider && !instructions) return [{ json: { ctx, needs_model: false, path: "rules", result, cat_max: CAT_MAX, ceiling } }];

const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["normalized_name", "category", "fridge_days", "freezer_days", "counter_days", "after_open_days", "due_type", "risk", "confidence", "notes"],
  properties: {
    normalized_name: { type: "string" },
    category: { type: "string", enum: ["laitier", "oeufs", "viande", "volaille", "charcuterie", "poisson", "vegetal", "traiteur", "plat_cuisine", "boulangerie", "fruit", "legume", "epicerie", "surgele", "boisson", "autre"] },
    fridge_days: { type: ["integer", "null"] }, freezer_days: { type: ["integer", "null"] },
    counter_days: { type: ["integer", "null"] }, after_open_days: { type: ["integer", "null"] },
    due_type: { type: "integer", enum: [1, 2] }, risk: { type: "string", enum: ["low", "medium", "high"] },
    confidence: { type: "number" }, notes: { type: "string" },
  },
};
const NOTES_LANG = { fr: "une phrase en français", en: "une phrase rédigée en ANGLAIS (English), même si l'indice de la table est en français" };
const SYSTEM = `Tu es un assistant de sécurité alimentaire pour une cuisine domestique en France.
On te donne un produit (nom, marque, catégorie) ou un plat maison (nom + ingrédients).
Tu estimes des durées de conservation PRUDENTES en jours entiers, pour un réfrigérateur à 0-4 °C
et un congélateur à -18 °C, en suivant les recommandations ANSES / DGAL, FSA et USDA FoodKeeper.

Règles:
- Donne la borne BASSE d'une fourchette. En cas de doute, raccourcis.
- fridge_days: produit fermé ou plat préparé, au réfrigérateur. null si le produit se garde au placard ou si seule la date imprimée compte.
- freezer_days: qualité optimale au congélateur. null si la congélation est déconseillée.
- counter_days: à température ambiante (environ 20 °C). 0 = pas plus de 2 heures hors du froid.
- after_open_days: après ouverture, là où le produit se garde une fois ouvert (réfrigérateur pour le frais,
  les bocaux et les sauces; placard pour l'épicerie sèche). null si non applicable.
- Plats cuisinés maison et restes: au plus 3 jours au réfrigérateur (ANSES). Riz cuit: 1 jour.
  Viande hachée, volaille crue, poisson cru, coquillages: 1 jour. Préparations aux œufs crus: 1 jour.
- due_type: 2 si le produit porte normalement une DLC (« à consommer jusqu'au », très périssable),
  1 si c'est une DDM (« à consommer de préférence avant »).
- risk: "high" si dépasser la durée expose à Listeria, Salmonella, Bacillus cereus, botulisme ou
  intoxication; "medium" si périssable; "low" si seule la qualité baisse.
- confidence: 0 à 1. Mets moins de 0.6 si le produit est ambigu ou inconnu.
- notes: ${NOTES_LANG[lang]}, 160 caractères maximum, conseil pratique de stockage.
Réponds uniquement avec l'objet JSON demandé, sur une seule ligne.`;
const KIND_FR = { dish: "plat maison ou reste", product: "produit du commerce", produce: "fruit ou légume frais" };
const STORAGE_FR = { fridge: "réfrigérateur", freezer: "congélateur", counter: "hors du frigo, à température ambiante" };
const USER = [
  "Produit: " + name,
  "Type: " + KIND_FR[kind],
  "Marque: inconnue",
  "Catégorie Grocy: " + (ctx.group_name || "aucune"),
  `Emplacement par défaut: ${loc.name || "inconnu"} (congélateur: ${loc.is_freezer == 1 ? "oui" : "non"})`,
  "Stockage prévu: " + STORAGE_FR[storage],
  "Ingrédients ou description: " + (ingredients || product.description || "aucun"),
  "Langue du champ notes: " + (lang === "fr" ? "français" : "anglais (English)"),
  "Indice de la table (peut être vide): " + (hint ? JSON.stringify(hint) : "{}"),
  ...(instructions ? ["Consignes de l'utilisateur (à suivre, sauf si elles vont contre les règles de sécurité ci-dessus): " + instructions] : []),
].join("\n");
const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: USER }];

const openrouter_body = {
  models: ["nvidia/nemotron-3-super-120b-a12b:free"],
  reasoning: { enabled: false }, temperature: 0, max_tokens: 400,
  provider: { require_parameters: true },
  response_format: { type: "json_schema", json_schema: { name: "shelf_life", strict: true, schema: SCHEMA } },
  plugins: [{ id: "response-healing" }], messages,
};
const groq_body = {
  model: "qwen/qwen3.8-27b", temperature: 0, max_tokens: 400, messages,
  response_format: { type: "json_schema", json_schema: { name: "shelf_life", strict: true, schema: SCHEMA } },
};
const mistral_body = {
  model: "ministral-14b-latest", temperature: 0, max_tokens: 400, messages,
  response_format: { type: "json_schema", json_schema: { name: "shelf_life", strict: true, schema: SCHEMA } },
};
const gemini_body = {
  systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text: USER }] }],
  generationConfig: { temperature: 0, maxOutputTokens: 400, responseMimeType: "application/json", responseJsonSchema: SCHEMA,
    thinkingConfig: { thinkingBudget: 0 } },
};
const ollama_body = {
  model: "qwen3:8b", stream: false, think: false, keep_alive: -1, format: SCHEMA,
  options: { temperature: 0, num_predict: 400, num_ctx: 2048 }, messages,
};

return [{ json: { ctx, needs_model: true, path: "model", hint, ceiling, cat_max: CAT_MAX, openrouter_body, groq_body, mistral_body, gemini_body, ollama_body } }];
