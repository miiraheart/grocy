// Live check of the shopping-inbox TEST twin on a free model with the OpenRouter test key (never the app key).
//   node live-twin.mjs          runs the built twin on this Mac (recipe-import/test/n8n-local.mjs)
//   node live-twin.mjs --n8n    posts to the deployed twin webhook (after Mira's OK for the test credential)
// The reader never writes Grocy, so there is nothing to undo.
import { execFileSync } from "node:child_process";
import { loadTwin, runTwin } from "../../recipe-import/test/n8n-local.mjs";

const TWIN_URL = "https://n8n.audibox.cc/webhook/shopping-inbox-test";
const MESSY = "coucou, tu peux prendre du lait, 2 baguettes et le truc pour le lave vaisselle stp, merci";
const check = (ok, message) => { if (!ok) throw new Error(message); };

async function post(body) {
  if (process.argv.includes("--n8n")) {
    const secret = execFileSync("ssh", ["audibox", "cat /home/miira/apps/docker/n8n-templates/webhook.secret"], { encoding: "utf8" }).trim();
    const res = await fetch(TWIN_URL, { method: "POST", headers: { "Content-Type": "application/json", "X-Trigger-Secret": secret }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }
  const twin = loadTwin("shopping-inbox-test.json");
  return runTwin(twin, { headers: { "x-trigger-secret": twin.secret }, body }).response;
}

const t0 = Date.now();
const res = await post({ text: MESSY, lists: ["Liste de courses", "Biocoop"], language_hint: "fr" });
const ms = Date.now() - t0;
console.log("answered", res.status, "in", ms, "ms:", JSON.stringify(res.body));
check(res.status === 200 && res.body.ok, "the twin did not answer ok");
const items = res.body.items;
check(items.length === 3, "3 items expected, got " + items.length);
check(items.some((i) => /lait/i.test(i.name)), "lait missing");
check(items.some((i) => /baguette/i.test(i.name) && i.amount === 2), "2 baguettes missing");
check(items.some((i) => /vaisselle/i.test(i.name)), "the dishwasher item missing");
check(/^openrouter:.*:free$/.test(res.body.parser), "parser is not a :free model: " + res.body.parser);
check(ms < 20000 || !process.argv.includes("--n8n"), "slower than 20 s");
const refused = await post({ text: "x".repeat(20001) });
check(refused.status === 413 && refused.body.ok === false, "a text over 20000 characters is refused");
console.log("ok  messy French text gives 3 items on " + res.body.parser + "; the long text is refused");
