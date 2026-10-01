// Live check of the assistant-intake TEST twin on a free model with the OpenRouter test key (never the app key).
//   node live-twin.mjs          runs the built twin on this Mac (recipe-import/test/n8n-local.mjs)
//   node live-twin.mjs --n8n    posts to the deployed twin webhook (after Mira's OK for the test credential)
// The workflow never writes Grocy, so there is nothing to undo.
import { execFileSync } from "node:child_process";
import { loadTwin, runTwin } from "../../recipe-import/test/n8n-local.mjs";

const TWIN_URL = "https://n8n.audibox.cc/webhook/assistant-intake-test";
const check = (ok, message) => { if (!ok) throw new Error(message); };
const BASE = {
  today: "2026-10-01", timezone: "Europe/Paris", locations: [{ id: 2, name: "Réfrigérateur", kind: "fridge" }, { id: 3, name: "Placard", kind: "pantry" }, { id: 4, name: "Congélateur", kind: "freezer" }],
  units: [{ id: 2, name: "Pièce" }], shortlist: [{ id: 10, name: "Yaourt nature" }, { id: 11, name: "Lait demi-écrémé" }, { id: 12, name: "Riz basmati" }],
  tasks: [{ id: 5, name: "Appeler la banque", due: "2026-10-02" }], chores: [{ id: 7, name: "Aspirateur", next: "2026-10-01", rule: "weekly", room: null }],
  lists: [{ id: 1, name: "Liste de courses" }], active_list_id: 1, screen: {},
};
const ONLY = process.argv.find((a) => a.startsWith("--only="));
const CASES = [
  ["fr batch", "j'ai acheté 4 yaourts au frigo et il n'y a plus de lait", (ops) => ops.some((o) => o.op === "add" && o.product_id === 10 && o.amount === 4 && o.location_id === 2) && ops.some((o) => o.op === "out_of" && o.product_id === 11)],
  ["en chore", "I did the vacuuming this morning", (ops) => ops.some((o) => o.op === "chore_done" && o.target_id === 7)],
  ["en ask", "what expires this week?", (ops) => ops.some((o) => o.op === "ask" && o.query === "expiring")],
  ["fr screen", "mets-le au congélo", (ops) => ops.some((o) => o.op === "move" && o.product_id === 12 && o.target_location_id === 4), { screen: { product: { id: 12, name: "Riz basmati" } } }],
];

async function post(body) {
  if (process.argv.includes("--n8n")) {
    const secret = execFileSync("ssh", ["audibox", "cat /home/miira/apps/docker/n8n-templates/webhook.secret"], { encoding: "utf8" }).trim();
    const res = await fetch(TWIN_URL, { method: "POST", headers: { "Content-Type": "application/json", "X-Trigger-Secret": secret }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }
  const twin = loadTwin("assistant-intake-test.json");
  return runTwin(twin, { headers: { "x-trigger-secret": twin.secret }, body }).response;
}

let failed = 0;
for (const [name, text, expect, extra] of CASES.filter((c) => !ONLY || c[0] === ONLY.slice(7))) {
  const t0 = Date.now();
  let res = await post({ ...BASE, ...(extra || {}), text });
  if (res.status === 502 && /timeout|429/i.test(res.body.error || "")) res = await post({ ...BASE, ...(extra || {}), text });
  const ops = (res.body.operations || []).map((o) => ({ op: o.op, product_id: o.product_id, amount: o.amount, location_id: o.location_id, target_location_id: o.target_location_id, target_id: o.target_id, query: o.query }));
  const good = res.status === 200 && /^openrouter:.*:free$/.test(res.body.model) && expect(res.body.operations || []);
  if (!good) failed++;
  console.log((good ? "ok  " : "FAIL ") + name + " in " + (Date.now() - t0) + " ms on " + res.body.model + ": " + JSON.stringify(ops));
}
const refused = await post({ ...BASE, text: "x".repeat(4001) });
check(refused.status === 413, "a text over 4000 characters is refused");
console.log("ok  the long text is refused");
process.exit(failed ? 1 : 0);
