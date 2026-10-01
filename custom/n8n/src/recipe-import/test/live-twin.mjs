// Live tests of the recipe-import TEST twin against grocy-test.
//   node live-twin.mjs <mode> [--n8n]
// Default: the built twin runs on this Mac (test/n8n-local.mjs). --n8n posts to the deployed twin webhook instead.
// Modes: text messy web heuristic tiktok fail retry duplicate. Every mode deletes what it made and sweeps "ZZ test" recipes.
import { execFileSync } from "node:child_process";
import { grocy, recipeFields, sweep } from "./grocy-test.mjs";
import { loadTwin, runTwin } from "./n8n-local.mjs";

const TWIN_URL = "https://n8n.audibox.cc/webhook/recipe-import-test";
const PAGES = {
  web: "https://www.marmiton.org/recettes/recette_pate-a-crepes_12372.aspx",
  heuristic: "https://en.wikibooks.org/wiki/Cookbook:Guacamole_I",
  tiktok: "https://www.tiktok.com/@mamyetjordan_/video/7303575334799166753",
  fail: "https://example.com/",
};
const TEXT = "ZZ test poulet coco\nPour 4 personnes\nIngrédients\n600 g de hauts de cuisse de poulet\n40 cl de lait de coco\n"
  + "2 c.à.s. de coconut aminos\n1 bâton de citronnelle, émincé\nPréparation\n1. Faire dorer le poulet 5 min.\n"
  + "2. Ajouter le lait de coco, les aminos et la citronnelle.\n3. Laisser mijoter 20 min.";
const MESSY = "ZZ test poulet coco du dimanche. Pour quatre on fait dorer 600 g de hauts de cuisse de poulet dans une cocotte, "
  + "puis on verse 40 cl de lait de coco avec 2 c.à.s. de coconut aminos et un bâton de citronnelle émincé, et on laisse mijoter "
  + "une vingtaine de minutes avant de servir avec du riz.";

const mode = process.argv[2];
const onN8n = process.argv.includes("--n8n");
const made = new Set();
const check = (ok, message) => { if (!ok) throw new Error(message); };

let twin = null;
async function post(body) {
  if (onN8n) {
    if (!TWIN_URL.endsWith("-test")) throw new Error("not a twin URL");
    const secret = execFileSync("ssh", ["audibox", "cat /home/miira/apps/docker/n8n-templates/webhook.secret"], { encoding: "utf8" }).trim();
    const res = await fetch(TWIN_URL, { method: "POST", headers: { "Content-Type": "application/json", "X-Trigger-Secret": secret }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }
  twin ??= loadTwin("recipe-import-test.json");
  const run = runTwin(twin, { headers: { "x-trigger-secret": twin.secret }, body });
  run.done.catch((e) => console.error("run failed:", e.message));
  return run.response;
}

async function start(body) {
  const t0 = Date.now();
  const res = await post(body);
  check(res.status === 200 && res.body.ok, "start answered " + res.status + " " + JSON.stringify(res.body));
  if (res.body.recipe_id && !res.body.duplicate) made.add(res.body.recipe_id);
  console.log("answered in", Date.now() - t0, "ms", JSON.stringify(res.body));
  return res.body;
}

async function settle(id, seconds = 120) {
  for (let i = 0; i < seconds; i += 2) {
    const f = await recipeFields(id);
    if (f.import_status !== "pending") return { ...f, draft: f.import_draft ? JSON.parse(f.import_draft) : null };
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("recipe " + id + " still pending after " + seconds + " s");
}

async function ready(body, parserCheck) {
  const { recipe_id } = await start(body);
  const f = await settle(recipe_id);
  check(f.import_status === "ready", "status " + f.import_status + " " + (f.import_error || ""));
  const d = f.draft;
  check(d.v === 2 && d.groups.length && d.steps.length, "draft has no groups or steps");
  parserCheck(d.parser);
  const lines = d.groups.flatMap((g) => g.lines);
  console.log(mode, "ready", d.parser, d.name, lines.length, "lines", d.steps.length, "steps", d.image_url ? "image" : "no image");
  return { id: recipe_id, draft: d, lines, fields: f };
}

async function failed(body, stage) {
  const { recipe_id } = await start(body);
  const f = await settle(recipe_id);
  check(f.import_status === "failed" && f.import_error.startsWith(stage + ":"), "expected failed " + stage + ", got " + f.import_status + " " + f.import_error);
  console.log(mode, "failed as expected:", f.import_error);
  return recipe_id;
}

const modes = {
  async text() {
    const { lines, draft } = await ready({ kind: "text", text: TEXT }, (p) => check(p === "rules", "parser " + p));
    check(draft.name === "ZZ test poulet coco" && draft.servings === 4, "name or servings");
    check(lines.some((l) => l.quantity === 40 && l.unit === "cl" && l.name === "lait de coco"), "lait de coco line");
    check(draft.steps.length === 3, "3 steps");
  },
  async messy() {
    await ready({ kind: "text", text: MESSY }, (p) => check(/^model:.*:free$/.test(p), "parser " + p));
  },
  async web() {
    const { id, draft } = await ready({ kind: "url", url: PAGES.web + "?utm_source=test#top" }, (p) => check(p === "jsonld", "parser " + p));
    const recipe = await grocy("GET", "/objects/recipes/" + id);
    check(recipe.picture_file_name && recipe.picture_file_name.startsWith("r" + id + "-"), "picture not set");
    check(draft.source.url === PAGES.web, "url not normalised: " + draft.source.url);
  },
  async heuristic() {
    const r = await ready({ kind: "url", url: PAGES.heuristic }, (p) => check(p === "heuristic", "parser " + p + ": replace the heuristic page " + PAGES.heuristic));
    check(r.lines.length >= 5, "few lines: replace the heuristic page " + PAGES.heuristic);
  },
  async tiktok() {
    const { draft, fields } = await ready({ kind: "url", url: PAGES.tiktok }, (p) => check(p === "rules" || /^model:.*:free$/.test(p), "parser " + p));
    check(fields.source_kind === "tiktok" && fields.source_ref === "tiktok:7303575334799166753", "source " + fields.source_ref);
    check(draft.source.author, "author missing");
  },
  async fail() { await failed({ kind: "url", url: PAGES.fail }, "parse"); },
  async retry() {
    const id = await failed({ kind: "url", url: PAGES.fail }, "parse");
    const again = await start({ kind: "text", text: TEXT, retry_recipe_id: id });
    check(again.recipe_id === id, "retry made a new recipe");
    const f = await settle(id);
    check(f.import_status === "ready" && f.import_error === "", "retry status " + f.import_status);
    console.log("retry ready", f.draft.parser);
  },
  async duplicate() {
    const first = await start({ kind: "url", url: PAGES.web });
    await settle(first.recipe_id);
    const second = await start({ kind: "url", url: PAGES.web + "?utm_medium=share" });
    check(second.duplicate === true && second.recipe_id === first.recipe_id && second.name, "not a duplicate: " + JSON.stringify(second));
  },
};

async function cleanup() {
  for (const id of made) {
    const r = await grocy("GET", "/objects/recipes/" + id).catch(() => null);
    if (r && r.picture_file_name) await grocy("DELETE", "/files/recipepictures/" + Buffer.from(r.picture_file_name).toString("base64")).catch(() => null);
    if (r) await grocy("DELETE", "/objects/recipes/" + id);
  }
  await sweep();
}

if (!modes[mode]) { console.error("modes: " + Object.keys(modes).join(" ")); process.exit(2); }
await sweep();
try {
  await modes[mode]();
  console.log("PASS", mode, onN8n ? "(n8n twin)" : "(local twin run)");
} catch (e) {
  console.error("FAIL", mode, e.message);
  process.exitCode = 1;
} finally {
  await new Promise((r) => setTimeout(r, 1000));
  await cleanup();
}
