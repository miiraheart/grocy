// Kitchen: shopping inbox, Prepare. A text the inbox rules could not read (app or web, 17-32/17-33) becomes one
// structured OpenRouter request on free models. Nothing is written anywhere; the reply only lists items.
const SECRET = "__WEBHOOK_SECRET__";
const TWIN = false;
const MODELS = ["qwen/qwen3.8-27b:free", "nvidia/nemotron-3-super-120b-a12b:free"];
const MAX_TEXT = 20000;
const req = $input.first().json;
const headers = req.headers || {};
const stop = (http_status, reply) => [{ json: { http_status, reply, needs_model: false } }];
if (headers["x-trigger-secret"] !== SECRET) return stop(401, { ok: false, error: "unauthorized" });

const body = req.body || {};
const text = typeof body.text === "string" ? body.text.trim() : "";
if (!text) return stop(400, { ok: false, error: "text required" });
if (text.length > MAX_TEXT) return stop(413, { ok: false, error: "text over " + MAX_TEXT + " characters" });
const lists = (Array.isArray(body.lists) ? body.lists : []).filter((l) => typeof l === "string" && l.trim()).map((l) => l.trim().slice(0, 80)).slice(0, 50);

// The app's extractor prompt (IntakePrompt.inboxExtractRules) and schema (InboxExtractor.schema).
const system = [
  "You read a message, a note or a pasted list and return only the things to buy in it.",
  "- One item per thing to buy, named as the text names it, without articles (\"du lait\" is \"lait\").",
  "- amount: the number given (\"2 baguettes\" is 2), null when none. unit: g, kg, ml, cl, l, tbsp, tsp or null.",
  "- A vague thing stays one item named by what it is for (\"le truc pour le lave vaisselle\" is \"produit lave-vaisselle\").",
  "- list: the list a heading or the text names for the item (\"Biocoop:\", \"pour la pharmacie\"), else null. Lists: " + lists.join(", ") + ".",
  "- Greetings, thanks, sign offs, questions and chat are not items.",
  "- Keep the language of the text: never translate a name.",
].join("\n");
const schema = {
  type: "object",
  properties: { items: { type: "array", items: { type: "object", properties: {
    name: { type: "string" }, amount: { type: ["number", "null"] }, unit: { type: ["string", "null"] }, list: { type: ["string", "null"] },
  }, required: ["name", "amount", "unit", "list"], additionalProperties: false } } },
  required: ["items"], additionalProperties: false,
};
const openrouter_body = {
  models: MODELS, temperature: 0, max_tokens: 2000,
  messages: [{ role: "system", content: system }, { role: "user", content: text }],
  response_format: { type: "json_schema", json_schema: { name: "shopping_inbox", strict: true, schema } },
};
return [{ json: { needs_model: true, twin: TWIN, lists, openrouter_body } }];
