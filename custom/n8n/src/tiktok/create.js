
const GROCY = "http://grocy/api";
const GROCY_KEY = "__GROCY_API_KEY__";
const src = $("Read TikTok").first().json;
const llm = $input.first().json;
// Models sometimes emit half of an emoji pair, which is invalid UTF-8 once stored
const clean = (s) => String(s || "").toWellFormed().replace(/\uFFFD/g, "");
const esc = (s) => clean(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let r;
try {
  r = JSON.parse(llm.choices[0].message.content);
} catch (e) {
  r = { name: "", servings: null, has_recipe: false, ingredients: [], steps: [], diet_flags: [] };
}
const captionTitle = (src.caption.split(/[#\n]|Ingr/)[0] || "").replace(/[^\p{L}\p{N}' -]/gu, "").trim();
const looksLikeIngredient = r.ingredients.some(i => (i.name || "").toLowerCase() === (r.name || "").toLowerCase().trim());
const title = ((looksLikeIngredient ? "" : r.name) || captionTitle || "Recette TikTok").trim().slice(0, 80);
let name = clean(r.has_recipe ? title : "[À compléter] " + title);
if (r.diet_flags && r.diet_flags.length) name = "⚠️ " + name;

let html = "";
if (r.diet_flags && r.diet_flags.length) {
  html += "<p><strong>⚠️ Attention : " + esc(r.diet_flags.join(", ")) + "</strong></p>";
}
if (r.ingredients.length) {
  html += "<h3>Ingrédients</h3><ul>" + r.ingredients.map(i =>
    "<li>" + esc([i.quantity, i.name].filter(Boolean).join(" ")) + (i.note ? " <em>(" + esc(i.note.replace(/^\(+|\)+$/g, "")) + ")</em>" : "") + "</li>").join("") + "</ul>";
}
if (r.steps.length) {
  html += "<h3>Préparation</h3><ol>" + r.steps.map(s => "<li>" + esc(s) + "</li>").join("") + "</ol>";
}
html += "<h3>Description d'origine</h3><p>" + esc(src.caption).replace(/\n/g, "<br>") + "</p>";
html += '<p>Source : <a href="' + src.url + '">' + esc(src.url) + "</a>" +
        (src.author ? " · " + esc(src.author) : "") + "</p>";

const headers = { "GROCY-API-KEY": GROCY_KEY };
const created = await this.helpers.httpRequest({ method: "POST", url: GROCY + "/objects/recipes", headers, json: true,
  body: { name, description: html, base_servings: r.servings || 1, desired_servings: r.servings || 1 } });
const recipeId = Number(created.created_object_id);

const fileName = "tiktok-" + (src.videoId || recipeId) + ".jpg";
return [{ json: { ok: true, recipeId, name, hasRecipe: r.has_recipe,
  thumbnailUrl: src.thumbnailUrl, fileName, fileNameB64: Buffer.from(fileName).toString("base64"),
  ingredients: r.ingredients.length, steps: r.steps.length, dietFlags: r.diet_flags,
  model: llm.model || "", message: "Recette ajoutée : " + name } }];
