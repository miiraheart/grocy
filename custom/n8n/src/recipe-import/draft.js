// Draft (19-SPEC 7.5): model answer or structured result to import_draft v2, photo, status ready; any error to failed.
const TWIN = false;
const plan = $("Parse").first().json;
const { ctx, page } = plan;
const helpers = this.helpers;
const cleanName = (s) => String(s || "").replace(/#[\p{L}\p{N}_]+/gu, "").replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}️‍]/gu, "")
  .replace(/\s+/g, " ").trim().slice(0, 120);
const parseJson = (text) => { try { return JSON.parse(String(text).replace(/^\s*```(?:json)?|```\s*$/g, "").trim()); } catch (e) { return null; } };
const minutes = (v) => (Number.isFinite(Number(v)) && v !== null && Number(v) > 0 ? Math.round(Number(v)) : null);

function fromModel(r) {
  if (!r || typeof r !== "object" || !Array.isArray(r.groups) || !Array.isArray(r.steps)) return null;
  const groups = r.groups.map((g) => ({ name: cleanLine(g.name || ""), lines: (g.lines || []).map((l) => {
    const parsed = parseLine(l.raw || [l.quantity, l.unit, l.name].filter((x) => x !== null && x !== undefined && x !== "").join(" "));
    if (!parsed.name && l.name) parsed.name = String(l.name);
    if (l.optional) parsed.optional = true;
    return parsed;
  }).filter((l) => l.raw.trim()) })).filter((g) => g.lines.length);
  return { name: r.name || null, has_recipe: r.has_recipe !== false, language: r.language || null, servings: minutes(r.servings),
    servings_text: r.servings_text || null, times: { prep: minutes(r.prep_minutes), cook: minutes(r.cook_minutes), lead: minutes(r.lead_minutes) },
    tags: Array.isArray(r.tags) ? r.tags : [], notes: Array.isArray(r.notes) ? r.notes.map(String).filter(Boolean) : [], groups,
    steps: r.steps.map((s) => ({ section: String(s.section || ""), text: String(s.text || "").trim() })).filter((s) => s.text) };
}

async function modelAnswer() {
  const first = $input.first().json;
  const content = first && first.choices && first.choices[0] && first.choices[0].message && first.choices[0].message.content;
  const got = fromModel(parseJson(content));
  if (got) return { partial: got, model: first.model || plan.openrouter_body.models[0] };
  const errors = ["openrouter: " + String((first && first.error && (first.error.message || first.error)) || "invalid answer").slice(0, 120)];
  if (TWIN) throw new Error("parse: " + errors[0]);
  const messages = plan.openrouter_body.messages;
  const bodies = {
    groq: { model: "qwen/qwen3.8-27b", temperature: 0, messages, response_format: { type: "json_object" } },
    mistral: { model: "ministral-14b-latest", temperature: 0, messages, response_format: { type: "json_object" } },
    gemini: { contents: [{ role: "user", parts: [{ text: messages[0].content + "\n\n" + messages[1].content }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json" } },
  };
  for (const id of ["groq", "mistral", "gemini"]) {
    if (!hasKey(id)) continue;
    const p = HOSTED[id];
    const providerPlan = { groq_body: bodies.groq, mistral_body: bodies.mistral, gemini_body: bodies.gemini };
    try {
      const r = await helpers.httpRequest({ method: "POST", url: p.url, json: true, timeout: 60000,
        headers: { ...p.headers(KEYS[id]), "Content-Type": "application/json" }, body: p.body(providerPlan) });
      const parsed = fromModel(parseJson(p.text(r)));
      if (parsed) return { partial: parsed, model: id + ":" + p.model(r, providerPlan) };
      errors.push(id + ": invalid answer");
    } catch (e) { errors.push(id + ": " + String(e.message).slice(0, 80)); }
  }
  throw new Error("parse: " + errors.join("; "));
}

async function savePhoto(imageUrl) {
  if (!imageUrl) return null;
  const res = await fetchPublic(helpers, new URL(imageUrl, ctx.url || undefined).toString(), { binary: true, maxBytes: 8 * 1024 * 1024 });
  if (res.status >= 400 || res.body.length < 100) return null;
  const hex = Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const fileName = "r" + ctx.recipe_id + "-" + hex + ".jpg";
  await helpers.httpRequest({ method: "PUT", url: GROCY + "/files/recipepictures/" + Buffer.from(fileName).toString("base64"),
    headers: { "GROCY-API-KEY": GROCY_KEY, "Content-Type": "application/octet-stream" }, body: res.body, json: false, timeout: 30000 });
  await grocyCall(helpers, "PUT", "/objects/recipes/" + ctx.recipe_id, { picture_file_name: fileName });
  return fileName;
}

const raw = String(ctx.text || plan.model_text || "").slice(0, 60000);
try {
  if (plan.error) throw new Error(plan.error.stage + ": " + plan.error.message);
  let partial = plan.partial;
  let parser = plan.parser;
  if (plan.needs_model) {
    const answer = await modelAnswer();
    partial = answer.partial;
    parser = "model:" + answer.model;
  }
  if (lineCount(partial) === 0 && (partial.has_recipe === false || !partial.steps.length)) throw new Error("parse: no recipe found");
  const name = cleanName(partial.name) || cleanName(String(page.title || "").split(/ [|\-] /)[0]);
  const tags = [...new Set((partial.tags || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean))].slice(0, 6);
  const imageUrl = partial.image_url || page.image_url || null;
  const draft = { v: 2, name: name || null, name_suggested: !cleanName(partial.name), language: partial.language || ctx.language_hint || null,
    servings: partial.servings || null, servings_text: partial.servings_text || null,
    times: { prep: (partial.times && partial.times.prep) || null, cook: (partial.times && partial.times.cook) || null, lead: (partial.times && partial.times.lead) || null },
    tags, notes: partial.notes || [], source: { url: ctx.url || null, kind: ctx.source_kind, author: partial.author || page.author || null,
      ref: ctx.ref || null, title: page.title || null }, image_url: imageUrl, has_recipe: true,
    groups: partial.groups, steps: partial.steps, parser, transcript: false,
    stages: ctx.kind === "url" ? ["resolve", "read", "parse", "write"] : ["parse", "write"] };
  let photo = null;
  try { photo = await savePhoto(imageUrl); } catch (e) { photo = null; }
  if (name) await grocyCall(helpers, "PUT", "/objects/recipes/" + ctx.recipe_id, { name });
  await setFields(helpers, ctx.recipe_id, { import_status: "ready", import_error: "", import_draft: JSON.stringify(draft),
    import_raw: raw, source_author: draft.source.author || "" });
  return [{ json: { ok: true, recipe_id: ctx.recipe_id, import_status: "ready", parser, photo, lines: lineCount(partial), steps: partial.steps.length } }];
} catch (e) {
  const error = await markFailed(helpers, ctx.recipe_id, stageOf(e.message, "write"), e.message, raw);
  return [{ json: { ok: false, recipe_id: ctx.recipe_id, import_status: "failed", import_error: error } }];
}
