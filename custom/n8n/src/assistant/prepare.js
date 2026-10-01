// Kitchen: assistant intake, Prepare. The web assistant sends what she typed or said plus what the page knows
// (places, units, shortlist, screen, tasks, chores, lists); this builds the app's intake call from the shared
// contract (contract.json, exported from the iOS app) and asks OpenRouter. Nothing is written here.
const SECRET = "__WEBHOOK_SECRET__";
const TWIN = false;
const CONTRACT = /*@CONTRACT@*/null;
const MAX_TEXT = 4000;
const WEB_OPS = {
  Core: ["add", "consume", "spoil", "open", "move", "set_amount", "set_date", "out_of", "update", "delete", "undo"],
  "Shopping list": ["list_done", "list_undone", "list_remove", "list_amount", "list_note"],
  "Tasks and chores": ["task_add", "task_done", "task_undone", "chore_done"],
};
const WEB_QUERIES = ["have", "expiring", "expired", "where", "list", "low", "tasks", "chores"];
const req = $input.first().json;
const headers = req.headers || {};
const stop = (http_status, reply) => [{ json: { http_status, reply, needs_model: false } }];
if (headers["x-trigger-secret"] !== SECRET) return stop(401, { ok: false, error: "unauthorized" });

const body = req.body || {};
const text = typeof body.text === "string" ? body.text.trim() : "";
if (!text) return stop(400, { ok: false, error: "text required" });
if (text.length > MAX_TEXT) return stop(413, { ok: false, error: "text over " + MAX_TEXT + " characters" });
if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.today || ""))) return stop(400, { ok: false, error: "today required" });

const clean = (s, n) => String(s == null ? "" : s).replace(/[\r\n|]+/g, " ").trim().slice(0, n || 120);
const rows = (list, max) => (Array.isArray(list) ? list : []).filter((x) => x && Number.isInteger(+x.id) && +x.id > 0).slice(0, max);
const locations = rows(body.locations, 60);
const units = rows(body.units, 120);
const shortlist = rows(body.shortlist, 150);
const tasks = rows(body.tasks, 80);
const chores = rows(body.chores, 80);
const lists = rows(body.lists, 50);
const answered = (Array.isArray(body.answered) ? body.answered : []).filter((a) => a && Number.isInteger(+a.product_id)).slice(0, 30);
const recent = (Array.isArray(body.recent_rows) ? body.recent_rows : []).filter((r) => r && typeof r.row_id === "string").slice(-10);
const screen = body.screen && typeof body.screen === "object" ? body.screen : {};

const weekday = new Date(body.today + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
const capability = ["What the web can do (every write is one of these operations; questions are ask with a query):"]
  .concat(Object.keys(WEB_OPS).map((k) => "- " + k + ": " + WEB_OPS[k].slice().sort().join(", ")))
  .concat(["- Questions: " + WEB_QUERIES.join(", "), "- Anything else: no operation, never an invented one."]).join("\n");
const system = CONTRACT.rules + "\n" + CONTRACT.stock_detail_rules + "\n\n"
  + [CONTRACT.area_preamble, CONTRACT.area_rules.chores, CONTRACT.area_rules.list].join("\n\n") + "\n\n" + capability
  + "\n\nLocations (id|name):\n" + locations.map((l) => l.id + "|" + clean(l.name) + (l.kind && l.kind !== "other" ? " (" + clean(l.kind, 20) + ")" : "")).join("\n")
  + "\n\nUnits (id|name):\n" + units.map((u) => u.id + "|" + clean(u.name)).join("\n")
  + "\n\nToday: " + body.today + " " + weekday + " (" + clean(body.timezone || "Europe/Paris", 40) + ")";

const section = (title, lines) => "\n" + title + ":\n" + (lines.length ? lines.join("\n") : "none") + "\n";
const onStock = [], onScreen = [];
if (screen.product && +screen.product.id) onStock.push("product " + +screen.product.id + "|" + clean(screen.product.name) + "  (it, this, ça, le, la, this product)");
if (screen.entry && +screen.entry.id) {
  const e = screen.entry;
  onStock.push(["batch " + +e.id + " of product " + +e.product_id, "amount " + (+e.amount || 0), "location " + (+e.location_id || "none"),
    "best_before " + (clean(e.best_before, 10) || "none"), e.opened ? "opened" : "closed"].join("|") + "  (this one, this batch, it, celui-ci)");
}
if (Array.isArray(screen.location_ids) && screen.location_ids.length) onStock.push("stock tab filtered to location " + screen.location_ids.map(Number).join(", ") + "  (here, ici, in there)");
if (screen.list && +screen.list.id) onScreen.push("shopping list " + +screen.list.id + "|" + clean(screen.list.name) + "  (this list, cette liste)");
if (screen.recipe && +screen.recipe.id) onScreen.push("recipe " + +screen.recipe.id + "|" + clean(screen.recipe.name) + "  (this recipe, cette recette, it, la)");
if (screen.task && +screen.task.id) onScreen.push("task " + +screen.task.id + "|" + clean(screen.task.name) + "  (this task, cette tâche, it)");
if (screen.chore && +screen.chore.id) onScreen.push("chore " + +screen.chore.id + "|" + clean(screen.chore.name) + "  (this chore, cette corvée, it)");

const user = "Recent rows (" + recent.length + " of " + recent.length + "):\n"
  + (recent.length ? recent.map((r) => JSON.stringify(r)).join("\n") : "none") + "\n\n"
  + "Shortlist (id|name):\n" + (shortlist.length ? shortlist.map((p) => p.id + "|" + clean(p.name)).join("\n") : "none") + "\n"
  + (answered.length ? "\nLast answer (product_id|name|amount|best_before):\n" + answered.map((a) => [+a.product_id, clean(a.name), a.amount == null ? "" : +a.amount, clean(a.best_before, 10)].join("|")).join("\n") + "\n" : "")
  + (onStock.length ? "\nOn screen (stock):\n" + onStock.join("\n") + "\n" : "")
  + (onScreen.length ? section("On screen", onScreen) : "")
  + section("Tasks (id|name|due)", tasks.map((t) => [t.id, clean(t.name), clean(t.due, 16) || "none"].join("|")))
  + section("Chores (id|name|next day|rule|room)", chores.map((c) => [c.id, clean(c.name), clean(c.next, 16) || "none", clean(c.rule, 30) || "none", clean(c.room, 20) || "none"].join("|")))
  + section("Shopping lists (id|name)", lists.map((l) => l.id + "|" + clean(l.name) + (+l.id === +body.active_list_id ? "|active" : "")))
  + "Utterances:\n1.\n   text: \"" + text.replace(/"/g, "'") + "\"";

// The same wire body as the app's OpenRouterClient: fallback models, required parameters, no reasoning on thinking
// models, a cache breakpoint after the system prompt on Gemini.
const models = TWIN ? CONTRACT.models.free : CONTRACT.models.live;
const thinking = ["qwen3", "nemotron", "deepseek-r1", "magistral", "gpt-5", "/o1", "/o3", "/o4", "thinking"].some((m) => models[0].toLowerCase().includes(m));
const cached = models[0].toLowerCase().startsWith("google/gemini");
const openrouter_body = {
  model: models[0], models, temperature: 0, max_tokens: 6000, provider: { require_parameters: true }, usage: { include: true },
  messages: [{ role: "system", content: cached ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : system }, { role: "user", content: user }],
  response_format: { type: "json_schema", json_schema: { name: CONTRACT.schema_name, strict: true, schema: CONTRACT.schema } },
};
if (thinking) openrouter_body.reasoning = { enabled: false };
const allowed = {
  products: shortlist.map((p) => +p.id).concat(answered.map((a) => +a.product_id), screen.product ? [+screen.product.id] : [], screen.entry ? [+screen.entry.product_id] : []),
  locations: locations.map((l) => +l.id), units: units.map((u) => +u.id), tasks: tasks.map((t) => +t.id),
  chores: chores.map((c) => +c.id), lists: lists.map((l) => +l.id), rows: recent.map((r) => r.row_id),
};
return [{ json: { needs_model: true, twin: TWIN, allowed, openrouter_body } }];
