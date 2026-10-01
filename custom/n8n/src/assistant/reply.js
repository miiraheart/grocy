// Kitchen: assistant intake, Reply. Checks the model answer the way the app's IntakeValidator does before anything
// is shown: ids only from what the page sent, dates as YYYY-MM-DD, amounts positive. The page shows the operations
// as cards and writes nothing until she confirms.
const MAX_OPS = 40;
const prep = $("Prepare").first().json;
const res = $input.first().json || {};
const fail = (error) => [{ json: { http_status: 502, reply: { ok: false, error } } }];
const content = res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
if (res.error || typeof content !== "string") return fail("model failed: " + ((res.error && res.error.message) || "no answer"));

let parsed;
try { parsed = JSON.parse(content.replace(/^\s*```(?:json)?|```\s*$/g, "").trim()); } catch (e) { return fail("model answer is not JSON"); }
if (!parsed || !Array.isArray(parsed.operations)) return fail("model answer has no operations");

const ops = prep.openrouter_body.response_format.json_schema.schema.properties.operations.items.properties.op.enum;
const a = prep.allowed;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TASK_OPS = ["task_done", "task_undone", "task_edit", "task_delete"];
const CHORE_OPS = ["chore_done", "chore_skip", "chore_undone", "chore_postpone", "chore_edit", "chore_delete"];
const LIST_TARGET_OPS = ["list_delete", "list_switch"];
const idIn = (v, list) => (Number.isInteger(v) && list.includes(v) ? v : null);
const day = (v) => (typeof v === "string" && DAY.test(v) ? v : null);
const str = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n || 200) : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

const operations = parsed.operations.slice(0, MAX_OPS).filter((o) => o && ops.includes(o.op)).map((o) => {
  const targets = TASK_OPS.includes(o.op) ? a.tasks : CHORE_OPS.includes(o.op) ? a.chores : LIST_TARGET_OPS.includes(o.op) ? a.lists : null;
  const product_id = idIn(o.product_id, a.products);
  return {
    op: o.op, utterance: Number.isInteger(o.utterance) ? o.utterance : 1,
    row_id: typeof o.row_id === "string" && a.rows.includes(o.row_id) ? o.row_id : null,
    row_ids: Array.isArray(o.row_ids) ? o.row_ids.filter((r) => a.rows.includes(r)) : [],
    scope: ["listed", "last_batch", "all_session"].includes(o.scope) ? o.scope : "none",
    product_id, name_spoken: str(o.name_spoken, 120), name_fr: str(o.name_fr, 120), amount: num(o.amount),
    qu_id: idIn(o.qu_id, a.units), best_before: day(o.best_before),
    best_before_source: ["spoken", "past"].includes(o.best_before_source) && day(o.best_before) ? o.best_before_source : "none",
    location_id: idIn(o.location_id, a.locations), target_location_id: idIn(o.target_location_id, a.locations),
    whole: o.whole === true, query: typeof o.query === "string" ? o.query : "none", days: Number.isInteger(o.days) && o.days >= 0 ? o.days : null,
    undo_target: ["last", "product", "utterance", "session"].includes(o.undo_target) ? o.undo_target : "none",
    undo_count: Number.isInteger(o.undo_count) && o.undo_count > 0 ? Math.min(o.undo_count, 20) : null,
    source_span: str(o.source_span, 200), target_id: targets ? idIn(o.target_id, targets) : null, text: str(o.text, 500), day: day(o.day),
    price: typeof o.price === "number" && o.price >= 0 ? o.price : null, purchased_on: day(o.purchased_on), opened: o.opened === true,
    opened_on: day(o.opened_on), list_id: idIn(o.list_id, a.lists),
    values: Array.isArray(o.values) ? o.values.map((v) => str(v, 120)).filter(Boolean).slice(0, 50) : null,
    details: o.details && typeof o.details === "object" ? { time: str(o.details.time, 5), priority: str(o.details.priority, 10), done_at: str(o.details.done_at, 16) } : null,
    confidence: o.confidence && typeof o.confidence === "object" ? o.confidence : null,
    needs_clarification: o.needs_clarification === true || (targets !== null && idIn(o.target_id, targets) === null),
  };
});
const heard = (Array.isArray(parsed.heard) ? parsed.heard : []).filter((h) => h && typeof h.text === "string").slice(0, 5)
  .map((h) => ({ text: h.text.slice(0, 500), reply_language: ["en", "fr", "mixed"].includes(h.reply_language) ? h.reply_language : "en",
    confirmation: typeof h.confirmation === "string" ? h.confirmation.slice(0, 120) : "" }));
return [{ json: { http_status: 200, reply: { ok: true, heard, operations, model: "openrouter:" + (res.model || "unknown") } } }];
