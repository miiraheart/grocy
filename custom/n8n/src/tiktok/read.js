
const SECRETS = ["__TIKTOK_SECRET__", "__WEBHOOK_SECRET__"];
const GROCY = "http://grocy/api";
const GROCY_KEY = "__GROCY_API_KEY__";
const req = $input.first().json;
const headers = req.headers || {};
if (!SECRETS.includes(headers["x-trigger-secret"])) {
  return [{ json: { ok: false, stop: true, message: "Unauthorized" } }];
}
let url = String((req.body && (req.body.url || req.body.text)) || "").trim();
const m = url.match(/https?:\/\/\S*tiktok\.com\S*/);
if (!m) return [{ json: { ok: false, stop: true, message: "No TikTok link found" } }];
url = m[0];

// Short links (vm.tiktok.com / tiktok.com/t/) redirect to the full video URL
if (!/\/video\/\d+/.test(url)) {
  const res = await this.helpers.httpRequest({ url, method: "GET", returnFullResponse: true,
    ignoreHttpStatusErrors: true, headers: { "User-Agent": "Mozilla/5.0" } });
  const finalUrl = (res.request && res.request.res && res.request.res.responseUrl) || "";
  if (/\/video\/\d+/.test(finalUrl)) url = finalUrl;
}
url = url.split("?")[0];
const videoId = (url.match(/\/video\/(\d+)/) || [])[1] || "";

const oembed = await this.helpers.httpRequest({
  url: "https://www.tiktok.com/oembed?url=" + encodeURIComponent(url), json: true });

if (videoId) {
  const existing = await this.helpers.httpRequest({
    url: GROCY + "/objects/recipes?query%5B%5D=description~" + videoId,
    headers: { "GROCY-API-KEY": GROCY_KEY }, json: true });
  if (existing.length) {
    return [{ json: { ok: true, stop: true, duplicate: true, name: existing[0].name,
      message: "Already imported: " + existing[0].name } }];
  }
}

const caption = oembed.title || "";
const system = [
  "Tu extrais une recette depuis la description d'une vidéo TikTok.",
  "Garde la langue d'origine (souvent le français).",
  "name = le nom du plat (ex: \"Crêpes\", \"Gâteau au chocolat\"), JAMAIS un ingrédient, sans emoji ni hashtag.",
  "N'invente JAMAIS de quantités ni d'ingrédients absents du texte: laisse quantity vide si elle n'est pas donnée.",
  "quantity contient le nombre ET l'unité exactement comme écrits (ex: \"250 g\", \"500 ml\", \"1 càs\", \"4\").",
  "has_recipe = false si le texte ne contient pas de vraie liste d'ingrédients.",
  "diet_flags (en français, un mot court par problème, ex: \"gluten\", \"produits laitiers\", \"oeufs\", \"sucre\"): ce qui pose problème pour ce régime: avoine, sarrasin (anaphylaxie),",
  "oeufs, ananas, colza, sucre (canne ou ajouté), gluten (blé, orge, seigle, épeautre, sauce soja), produits laitiers, sésame, porc.",
].join(" ");

const schema = {
  type: "object", additionalProperties: false,
  required: ["name", "servings", "has_recipe", "ingredients", "steps", "diet_flags"],
  properties: {
    name: { type: "string" },
    servings: { type: ["number", "null"] },
    has_recipe: { type: "boolean" },
    ingredients: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["quantity", "name", "note"],
      properties: { quantity: { type: "string" }, name: { type: "string" }, note: { type: "string" } } } },
    steps: { type: "array", items: { type: "string" } },
    diet_flags: { type: "array", items: { type: "string" } },
  },
};

return [{ json: {
  ok: true, stop: false, url, videoId, caption,
  author: oembed.author_name || "", authorUrl: oembed.author_url || "",
  thumbnailUrl: oembed.thumbnail_url || "",
  llmRequest: {
    models: ["qwen/qwen3.8-27b:free", "nvidia/nemotron-3-super-120b-a12b:free"],
    provider: { require_parameters: true },
    temperature: 0,
    messages: [ { role: "system", content: system }, { role: "user", content: caption } ],
    response_format: { type: "json_schema", json_schema: { name: "recipe", strict: true, schema } },
  },
} }];
