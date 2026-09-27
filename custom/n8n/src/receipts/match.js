
const GROCY = "http://grocy/api";
const GROCY_KEY = "__GROCY_API_KEY__";
const x = $("Parse").first().json;
if (x.reply) return [{ json: { http_status: x.http_status, reply: x.reply } }];

const receipt = { ...x.receipt };
const warnings = [...x.warnings];
const round2 = (v) => Math.round(v * 100) / 100;

const KEYS = { groq: "__GROQ_API_KEY__", mistral: "__MISTRAL_API_KEY__", gemini: "__GEMINI_API_KEY__" };
const GEMINI_MODEL = "gemini-2.5-flash";
let plan = null;
try { plan = $("Repair plan").first().json; } catch (e) { plan = null; }

function applyRepair(data, source) {
  if (!data || !Array.isArray(data.items) || !data.items.length) return "llm_repair_failed: " + source;
  const lines = [];
  for (const it of data.items) {
    lines.push({ label: it.name || it.raw_line, product_id: null, qty: it.quantity || 1, unit: it.unit === "kg" ? "kg" : "piece",
      unit_price: it.unit_price, total: it.line_total, is_discount: false, vat_code: null, matched_by: null, flags: ["llm_corrected"] });
    if (it.discount) lines.push({ label: "REMISE " + (it.name || ""), product_id: null, qty: 1, unit: "piece", unit_price: null,
      total: -Math.abs(it.discount), is_discount: true, vat_code: null, matched_by: null, flags: ["llm_corrected"] });
  }
  const sum = round2(lines.reduce((s, l) => s + (l.total || 0), 0));
  const total = receipt.total ?? data.total ?? null;
  if (total === null || Math.abs(sum - total) >= 0.011) return `llm_repair_rejected: ${source} lines ${sum} vs total ${total}`;
  Object.assign(receipt, { lines, lines_sum: sum, total, parser: "regex-v1+llm:" + source });
  if (!receipt.store && data.store) receipt.store = data.store;
  if (!receipt.date && data.purchase_date) receipt.date = data.purchase_date;
  for (let i = warnings.length - 1; i >= 0; i--) if (/sum_mismatch|no_total_found/.test(warnings[i])) warnings.splice(i, 1);
  return null;
}
const parseJson = (t) => { try { return JSON.parse(String(t).replace(/^```(?:json)?|```$/g, "").trim()); } catch (e) { return null; } };

if (x.needs_repair && plan) {
  let repaired = false;
  if (!plan.use_openrouter) warnings.push("llm_repair_skipped: quota " + plan.quota_remaining);
  else {
    let llm = null;
    try { llm = $("OpenRouter repair").first().json; } catch (e) { llm = null; }
    let content = null;
    try { content = llm.choices[0].message.content; } catch (e) { content = null; }
    const why = applyRepair(parseJson(content), "openrouter:" + ((llm && llm.model) || "free"));
    if (why) warnings.push(why); else repaired = true;
  }
  const rb = x.repair_body;
  const schema = rb.response_format.json_schema.schema;
  const openai = (model) => ({ model, temperature: 0, max_tokens: rb.max_tokens, messages: rb.messages,
    response_format: { type: "json_schema", json_schema: { name: "receipt", strict: true, schema } } });
  const HOSTED = [
    { id: "groq", url: "https://api.groq.com/openai/v1/chat/completions", body: openai("qwen/qwen3.8-27b"),
      headers: (k) => ({ Authorization: "Bearer " + k }), text: (r) => r.choices[0].message.content, model: (r) => r.model || "qwen/qwen3.8-27b" },
    { id: "mistral", url: "https://api.mistral.ai/v1/chat/completions", body: openai("ministral-14b-latest"),
      headers: (k) => ({ Authorization: "Bearer " + k }), text: (r) => r.choices[0].message.content, model: (r) => r.model || "ministral-14b-latest" },
    { id: "gemini", url: "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent",
      body: { systemInstruction: { parts: [{ text: rb.messages[0].content }] }, contents: [{ role: "user", parts: [{ text: rb.messages[1].content }] }],
        generationConfig: { temperature: 0, maxOutputTokens: rb.max_tokens, responseMimeType: "application/json", responseJsonSchema: schema,
          thinkingConfig: { thinkingBudget: 0 } } },
      headers: (k) => ({ "x-goog-api-key": k }), text: (r) => r.candidates[0].content.parts[0].text, model: (r) => r.modelVersion || GEMINI_MODEL },
  ];
  for (const p of HOSTED) {
    if (repaired || !KEYS[p.id] || KEYS[p.id].startsWith("__")) continue;
    try {
      const r = await this.helpers.httpRequest({ method: "POST", url: p.url, json: true, timeout: 20000,
        headers: { ...p.headers(KEYS[p.id]), "Content-Type": "application/json" }, body: p.body });
      const why = applyRepair(parseJson(p.text(r)), p.id + ":" + p.model(r));
      if (why) warnings.push(why); else repaired = true;
    } catch (e) { warnings.push("llm_repair_failed: " + p.id + " " + String(e.message).slice(0, 120)); }
  }
  if (repaired) for (let i = warnings.length - 1; i >= 0; i--) if (/^llm_repair_(failed|rejected|skipped)/.test(warnings[i])) warnings.splice(i, 1);
}

const products = (await this.helpers.httpRequest({ method: "GET", url: GROCY + "/objects/products", json: true,
  headers: { "GROCY-API-KEY": GROCY_KEY } })).filter((p) => p.active == 1);
const matches = [];
receipt.lines.forEach((line, i) => {
  if (line.is_discount) return;
  const m = matchLabel(line.label, products);
  if (m.product_id) { line.product_id = m.product_id; line.matched_by = m.method; }
  matches.push({ line_index: i, product_id: m.product_id, score: m.score, method: m.method, key: m.key,
    candidates: m.candidates.slice(0, 5).map((c) => ({ product_id: c.product_id, name: c.name, score: c.score })) });
});
receipt.sum_matches_total = receipt.total !== null && Math.abs(receipt.lines_sum - receipt.total) < 0.011;
return [{ json: { http_status: 200, reply: { receipt, warnings, matches } } }];
