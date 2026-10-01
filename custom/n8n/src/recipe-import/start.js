// Start (19-SPEC 7.2): secret, input check, URL normalisation, duplicates, then the pending recipe. Answers at once.
const SECRET = "__WEBHOOK_SECRET__";
const req = $input.first().json;
const body = req.body || {};
const stop = (http_status, reply) => [{ json: { go: false, http_status, reply } }];
const headerSecret = (req.headers || {})["x-trigger-secret"];
if (SECRET.startsWith("__") || headerSecret !== SECRET) return stop(401, { ok: false, error: "unauthorized" });

const kind = String(body.kind || (body.url ? "url" : "text"));
if (!["url", "text", "ocr"].includes(kind)) return stop(400, { ok: false, error: "kind must be url, text or ocr" });
const sections = body.sections && typeof body.sections === "object" ? body.sections : null;
let text = typeof body.text === "string" ? body.text : "";
if (!text.trim() && sections) {
  text = [sections.title || "", "Ingrédients", sections.ingredients || "", "Préparation", sections.steps || ""].join("\n");
}
text = text.replace(/\r\n?/g, "\n").trim();
if (text.length > 20000) return stop(400, { ok: false, error: "text longer than 20000 characters" });
if (kind !== "url" && !text) return stop(400, { ok: false, error: "text is empty" });
const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
if (kind === "url" && !rawUrl) return stop(400, { ok: false, error: "url is empty" });
const retryId = body.retry_recipe_id === undefined || body.retry_recipe_id === null ? null : Number(body.retry_recipe_id);
if (retryId !== null && !(Number.isInteger(retryId) && retryId > 0)) return stop(400, { ok: false, error: "retry_recipe_id must be a recipe id" });

let url = "";
let resolveError = "";
if (kind === "url") {
  try { url = await normaliseUrl(this.helpers, rawUrl); } catch (e) { url = rawUrl.slice(0, 2000); resolveError = e.message; }
}
const isTiktok = (() => { try { return /(^|\.)tiktok\.com$/i.test(new URL(url).hostname); } catch (e) { return false; } })();
const sourceKind = kind === "text" ? "text" : kind === "ocr" ? "photo" : isTiktok ? "tiktok" : "web";
const ref = isTiktok && tiktokId(url) ? "tiktok:" + tiktokId(url) : "";

let recipeId = retryId;
let name = "";
if (retryId) {
  let existing = null;
  try { existing = await grocyCall(this.helpers, "GET", "/objects/recipes/" + retryId); } catch (e) { existing = null; }
  if (!existing || existing.type !== "normal") return stop(404, { ok: false, error: "recipe " + retryId + " not found" });
  name = existing.name;
} else {
  if (url || ref) {
    const recipes = await grocyCall(this.helpers, "GET", "/objects/recipes?query%5B%5D=type%3Dnormal");
    const same = recipes.find((r) => {
      const f = r.userfields || {};
      return (url && f.source_url === url) || (ref && f.source_ref === ref);
    });
    if (same) return stop(200, { ok: true, duplicate: true, recipe_id: Number(same.id), name: same.name });
  }
  const firstLine = text.split("\n").map(cleanLine).find((l) => l && !headingKind(l)) || "";
  const quick = firstLine.replace(/#[\p{L}\p{N}_]+/gu, "").replace(/[\p{Extended_Pictographic}️‍]/gu, "").replace(/\s+/g, " ").trim();
  const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Paris" }).slice(0, 16);
  name = (quick.length >= 3 && quick.length <= 80 ? quick : "Import " + stamp);
  const created = await grocyCall(this.helpers, "POST", "/objects/recipes", { name, base_servings: 1, desired_servings: 1 });
  recipeId = Number(created.created_object_id);
}

await setFields(this.helpers, recipeId, { import_status: "pending", import_error: "", import_draft: "", source_url: url,
  source_kind: sourceKind, source_ref: ref, import_raw: text });
if (resolveError) {
  await markFailed(this.helpers, recipeId, "resolve", resolveError, text);
  return stop(200, { ok: true, recipe_id: recipeId, import_status: "failed" });
}

const ctx = { recipe_id: recipeId, kind, source_kind: sourceKind, url, ref, text, name,
  options: { heuristic: !(body.options && body.options.heuristic === false) },
  language_hint: body.language_hint === "en" ? "en" : body.language_hint === "fr" ? "fr" : "" };
return [{ json: { go: true, http_status: 200, reply: { ok: true, recipe_id: recipeId, import_status: "pending" }, ctx } }];
