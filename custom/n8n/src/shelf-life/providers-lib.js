const KEYS = { groq: "__GROQ_API_KEY__", mistral: "__MISTRAL_API_KEY__", gemini: "__GEMINI_API_KEY__" };
const OLLAMA = "http://ollama:11434/api/chat";
const GEMINI_MODEL = "gemini-2.5-flash";
const hasKey = (p) => KEYS[p] && !KEYS[p].startsWith("__");

const CATEGORIES = ["laitier", "oeufs", "viande", "volaille", "charcuterie", "poisson", "vegetal", "traiteur", "plat_cuisine", "boulangerie", "fruit", "legume", "epicerie", "surgele", "boisson", "autre"];
const day = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 1825) : null;
};
function validate(text) {
  let r;
  try { r = typeof text === "string" ? JSON.parse(text.replace(/^```(?:json)?|```$/g, "").trim()) : text; }
  catch (e) { return null; }
  if (!r || typeof r !== "object") return null;
  const out = {
    fridge_days: day(r.fridge_days), freezer_days: day(r.freezer_days),
    counter_days: day(r.counter_days), after_open_days: day(r.after_open_days),
    confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0.5)),
    category: CATEGORIES.includes(r.category) ? r.category : "autre",
    due_type: Number(r.due_type) === 2 ? 2 : 1,
    risk: ["low", "medium", "high"].includes(r.risk) ? r.risk : "medium",
    notes: String(r.notes || "").slice(0, 160),
  };
  const any = ["fridge_days", "freezer_days", "counter_days", "after_open_days"].some((f) => out[f] !== null);
  return any ? out : null;
}

const HOSTED = {
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", body: (plan) => plan.groq_body,
    headers: (k) => ({ Authorization: "Bearer " + k }), text: (r) => r.choices[0].message.content, model: (r, plan) => plan.groq_body.model },
  mistral: { url: "https://api.mistral.ai/v1/chat/completions", body: (plan) => plan.mistral_body,
    headers: (k) => ({ Authorization: "Bearer " + k }), text: (r) => r.choices[0].message.content, model: (r, plan) => r.model || plan.mistral_body.model },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent", body: (plan) => plan.gemini_body,
    headers: (k) => ({ "x-goog-api-key": k }), text: (r) => r.candidates[0].content.parts[0].text, model: (r) => r.modelVersion || GEMINI_MODEL },
};

// Calls one provider that does not need an n8n credential (OpenRouter is its own node). Returns { result } or { error }.
async function callProvider(helpers, plan, id) {
  if (id === "ollama") {
    try {
      const r = await helpers.httpRequest({
        method: "POST", url: OLLAMA, json: true, timeout: 150000,
        headers: { "Content-Type": "application/json" }, body: plan.ollama_body,
      });
      const result = validate(r.message && r.message.content);
      if (result) { result.source = "ollama:" + plan.ollama_body.model; return { result }; }
      return { error: "ollama: invalid answer" };
    } catch (e) { return { error: "ollama: " + String(e.message).slice(0, 200) }; }
  }
  const p = HOSTED[id];
  if (!p) return { error: id + ": unknown provider" };
  if (!hasKey(id)) return { error: id + ": no API key" };
  try {
    const r = await helpers.httpRequest({
      method: "POST", url: p.url, json: true, timeout: 20000,
      headers: { ...p.headers(KEYS[id]), "Content-Type": "application/json" }, body: p.body(plan),
    });
    const result = validate(p.text(r));
    if (result) { result.source = id + ":" + p.model(r, plan); return { result }; }
    return { error: id + ": invalid answer" };
  } catch (e) { return { error: id + ": " + String(e.message).slice(0, 200) }; }
}
