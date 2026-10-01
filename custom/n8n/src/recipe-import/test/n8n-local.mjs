// Runs a built TEST twin template on this Mac the way n8n would (webhook, code, if, http request, respond nodes),
// against grocy-test and OpenRouter with the test key. Refuses the real Grocy and any non twin template.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DIR } from "./load.mjs";
import { credential, GROCY_TEST } from "./grocy-test.mjs";

const TEST_CRED_ID = "orTestKey0000001";
const BLOCKED_HOSTS = ["grocy.audibox.cc", "grocy", "n8n.audibox.cc"];

function guard(url) {
  const host = new URL(url).hostname;
  if (BLOCKED_HOSTS.includes(host) || (host.endsWith(".audibox.cc") && host !== "grocy-test.audibox.cc")) throw new Error("local runner refuses " + host);
}

async function httpRequest(opts) {
  const url = String(opts.url).replace("http://grocy-test/api", GROCY_TEST);
  guard(url);
  const headers = { ...(opts.headers || {}) };
  let body = opts.body;
  if (body !== undefined && !Buffer.isBuffer(body) && typeof body === "object") { body = JSON.stringify(body); headers["Content-Type"] ??= "application/json"; }
  const res = await fetch(url, { method: opts.method || "GET", headers, body, redirect: opts.disableFollowRedirect ? "manual" : "follow",
    signal: AbortSignal.timeout(opts.timeout || 30000) });
  const buffer = Buffer.from(await res.arrayBuffer());
  let parsed;
  if (opts.encoding === "arraybuffer") parsed = buffer;
  else {
    parsed = buffer.toString("utf8");
    if (opts.json !== false && /json/.test(res.headers.get("content-type") || "") || opts.json === true) { try { parsed = JSON.parse(parsed); } catch (e) { parsed = String(parsed); } }
  }
  if (res.status >= 400 && !opts.ignoreHttpStatusErrors) throw new Error("Request failed with status code " + res.status + " " + String(buffer).slice(0, 160));
  if (opts.returnFullResponse) return { body: parsed, headers: Object.fromEntries(res.headers), statusCode: res.status };
  return parsed;
}

function evaluate(value, $json, $) {
  if (typeof value !== "string" || !value.startsWith("=")) return value;
  const run = (expr) => new Function("$json", "$", "return (" + expr + ");")($json, $);
  const whole = value.match(/^=\{\{([\s\S]*)\}\}$/);
  if (whole) return run(whole[1]);
  return value.slice(1).replace(/\{\{([\s\S]*?)\}\}/g, (m, e) => run(e));
}

export function loadTwin(file) {
  if (!/-test\.json$/.test(file)) throw new Error("only test twins run locally");
  const secret = randomBytes(12).toString("hex");
  const text = readFileSync(join(DIR, "..", "..", "templates", file), "utf8")
    .replaceAll("__GROCY_API_KEY__", credential("GROCY_API_KEY")).replaceAll("__WEBHOOK_SECRET__", secret);
  if (text.includes("http://grocy/")) throw new Error(file + " points at the real Grocy");
  return { wf: JSON.parse(text), secret };
}

// Returns { response, done }: response settles when the Respond node runs, done when the whole run ends.
export function runTwin({ wf }, request, log = () => {}) {
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const outputs = {};
  let answer;
  const response = new Promise((resolve) => { answer = resolve; });
  const $ = (name) => ({ first: () => outputs[name][0], item: outputs[name][0], all: () => outputs[name] });
  async function runNode(node, items) {
    const json = items[0].json;
    const p = node.parameters;
    switch (node.type) {
      case "n8n-nodes-base.webhook": return [items];
      case "n8n-nodes-base.code": {
        const fn = new (Object.getPrototypeOf(async function () {}).constructor)("$input", "$", p.jsCode);
        return [await fn.call({ helpers: { httpRequest } }, { first: () => items[0], all: () => items }, $)];
      }
      case "n8n-nodes-base.if": {
        const c = p.conditions.conditions[0];
        const left = evaluate(c.leftValue, json, $);
        const ok = c.operator.operation === "true" ? left === true || left === "true" : !(left === true || left === "true");
        return ok ? [items, []] : [[], items];
      }
      case "n8n-nodes-base.respondToWebhook":
        answer({ status: Number(evaluate(p.options.responseCode, json, $)), body: JSON.parse(evaluate(p.responseBody, json, $)) });
        return [items];
      case "n8n-nodes-base.httpRequest": {
        const headers = {};
        if (node.credentials && node.credentials.openRouterApi) {
          if (node.credentials.openRouterApi.id !== TEST_CRED_ID) throw new Error("twin uses a non test OpenRouter credential");
          headers.Authorization = "Bearer " + credential("OPENROUTER_TEST_KEY");
        }
        const body = p.sendBody ? JSON.parse(evaluate(p.jsonBody, json, $)) : undefined;
        if (body && body.models && !body.models.every((m) => m.endsWith(":free"))) throw new Error("twin model is not :free");
        try {
          const r = await httpRequest({ method: p.method, url: evaluate(p.url, json, $), headers, body, json: true, timeout: p.options.timeout });
          return [[{ json: r }]];
        } catch (e) {
          if (node.onError === "continueRegularOutput") return [[{ json: { error: { message: e.message } } }]];
          throw e;
        }
      }
      default: throw new Error("local runner has no " + node.type);
    }
  }
  const done = (async () => {
    let queue = [[wf.nodes.find((n) => n.type === "n8n-nodes-base.webhook").name, [{ json: request }]]];
    while (queue.length) {
      const [name, items] = queue.shift();
      const result = await runNode(byName[name], items);
      outputs[name] = result.flat();
      log(name, result.flat()[0] && result.flat()[0].json);
      const links = (wf.connections[name] && wf.connections[name].main) || [];
      links.forEach((targets, index) => {
        if (result[index] && result[index].length) for (const t of targets) queue.push([t.node, result[index]]);
      });
    }
    return outputs;
  })();
  done.catch((e) => answer({ status: 500, body: { ok: false, error: e.message } }));
  return { response, done };
}
