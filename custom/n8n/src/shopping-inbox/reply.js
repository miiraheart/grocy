// Kitchen: shopping inbox, Reply. Checks the model answer like InboxExtractor.parse: names not empty, amounts positive,
// units short, list_hint only from the lists the caller sent. The caller reviews everything before any write.
const MAX_ITEMS = 200;
const prep = $("Prepare").first().json;
const res = $input.first().json || {};
const fail = (error) => [{ json: { http_status: 502, reply: { ok: false, error } } }];
const content = res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
if (res.error || typeof content !== "string") return fail("model failed: " + ((res.error && res.error.message) || "no answer"));

let parsed;
try { parsed = JSON.parse(content.replace(/^\s*```(?:json)?|```\s*$/g, "").trim()); } catch (e) { return fail("model answer is not JSON"); }
if (!parsed || !Array.isArray(parsed.items)) return fail("model answer has no items");

const fold = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
const byFold = new Map(prep.lists.map((l) => [fold(l), l]));
const items = parsed.items.slice(0, MAX_ITEMS).map((it) => {
  const name = typeof it.name === "string" ? it.name.trim().slice(0, 120) : "";
  if (!name) return null;
  const amount = typeof it.amount === "number" && Number.isFinite(it.amount) && it.amount > 0 ? it.amount : null;
  const unit = typeof it.unit === "string" && it.unit.trim() && it.unit.trim().length <= 20 ? it.unit.trim().toLowerCase() : null;
  const list_hint = typeof it.list === "string" ? byFold.get(fold(it.list)) || null : null;
  return { name, amount, unit, note: null, list_hint };
}).filter(Boolean);
return [{ json: { http_status: 200, reply: { ok: true, items, parser: "openrouter:" + (res.model || "unknown") } } }];
