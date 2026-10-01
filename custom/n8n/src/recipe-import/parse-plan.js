// Parse plan (19-SPEC 7.4): JSON-LD, microdata, heuristic lists or rules without a model; else the model request.
const MODELS = [...new Set(["qwen/qwen3.8-27b:free", "nvidia/nemotron-3-super-120b-a12b:free"])];
const prev = $input.first().json;
const { ctx } = prev;
const page = prev.page || {};
const done = (fields) => [{ json: { ctx, page, needs_model: false, ...fields } }];
if (prev.error) return done({ error: prev.error });

const asGroups = (lines) => (lines.length ? [{ name: "", lines: lines.map(parseLine) }] : []);
const fromStructured = (r) => ({ name: r.name, servings: r.servings, servings_text: r.servings_text, times: r.times,
  tags: r.tags, notes: [], groups: asGroups(r.lines), steps: r.steps, image_url: r.image_url, author: r.author });

let partial = null;
let parser = null;
let modelText = "";
const html = prev.html || "";
if (html) {
  const ld = findRecipe(html);
  if (ld && ld.lines.length && ld.steps.length) { partial = fromStructured(ld); parser = "jsonld"; }
  if (!partial) {
    const md = microdata(html);
    if (md && md.lines.length && md.steps.length) { partial = fromStructured(md); parser = "microdata"; }
  }
  if (!partial && ctx.options.heuristic) {
    const h = heuristic(html);
    if (h.lines.length >= 2 && h.steps.length) {
      partial = fromStructured({ ...h, name: null, servings: null, servings_text: null, times: null, image_url: null, author: null, tags: [] });
      parser = "heuristic";
    }
  }
  if (partial && ld) {
    for (const key of ["name", "image_url", "author", "servings", "servings_text"]) if (!partial[key] && ld[key]) partial[key] = ld[key];
    if (!partial.tags.length) partial.tags = ld.tags;
  }
  if (!partial) modelText = [page.title ? "Title: " + page.title : "", prev.text || "", readableText(html)].filter(Boolean).join("\n\n");
} else {
  const split = splitText(prev.text || "");
  if (lineCount(split) >= 2 && split.steps.length) {
    partial = { ...split, tags: [], image_url: null, author: null };
    parser = "rules";
  } else {
    modelText = prev.text || "";
  }
}
if (partial) return done({ parser, partial });

const nullable = (type) => ({ type: [type, "null"] });
const schema = { type: "object", additionalProperties: false,
  required: ["name", "has_recipe", "language", "servings", "servings_text", "prep_minutes", "cook_minutes", "lead_minutes", "tags", "notes", "groups", "steps"],
  properties: {
    name: { type: "string" }, has_recipe: { type: "boolean" }, language: { type: "string" },
    servings: nullable("number"), servings_text: nullable("string"),
    prep_minutes: nullable("integer"), cook_minutes: nullable("integer"), lead_minutes: nullable("integer"),
    tags: { type: "array", items: { type: "string" } }, notes: { type: "array", items: { type: "string" } },
    groups: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "lines"], properties: {
      name: { type: "string" },
      lines: { type: "array", items: { type: "object", additionalProperties: false,
        required: ["raw", "quantity", "quantity_max", "unit", "name", "note", "optional"],
        properties: { raw: { type: "string" }, quantity: nullable("number"), quantity_max: nullable("number"), unit: nullable("string"),
          name: { type: "string" }, note: { type: "string" }, optional: { type: "boolean" } } } } } } },
    steps: { type: "array", items: { type: "object", additionalProperties: false, required: ["section", "text"],
      properties: { section: { type: "string" }, text: { type: "string" } } } },
  } };
const system = [
  "You read one recipe from a web page, a social media caption or pasted text and return it as JSON.",
  "Keep the language of the source for every text field; language is its ISO code (fr, en, de...).",
  "Never invent quantities, units or ingredients that are not written in the text. raw is the ingredient line exactly as written.",
  "quantity is the number as written (null when there is none), quantity_max the upper end of a range like 2-3.",
  "Group ingredients under the headings of the source (empty name when there is one list). Steps keep their order and section.",
  "notes are the author's own notes, tips or numbered or starred remarks. tags are 1 to 4 short lower case words for the dish type and the cuisine.",
  "Do not add diet warnings, flags or name prefixes. name is the dish name without emojis or hashtags.",
  "has_recipe is false when the text has no real ingredient list; then return empty groups and steps.",
].join(" ");
const openrouter_body = { models: MODELS, provider: { require_parameters: true }, temperature: 0,
  messages: [{ role: "system", content: system }, { role: "user", content: modelText.slice(0, 15000) }],
  response_format: { type: "json_schema", json_schema: { name: "recipe", strict: true, schema } } };
return [{ json: { ctx, page, needs_model: true, parser: "model", model_text: modelText.slice(0, 15000), openrouter_body } }];
