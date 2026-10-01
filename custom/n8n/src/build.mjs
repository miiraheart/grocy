// Builds n8n/templates/*.json from the node sources in n8n/src. Run: node n8n/src/build.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url));
const OUT = join(SRC, "..", "templates");
const read = (...p) => readFileSync(join(SRC, ...p), "utf8");
const OPENROUTER_CRED = { openRouterApi: { id: "l86vEWp9ZQt60YHZ", name: "OpenRouter account 2" } };
// Twins never use the app OpenRouter key: test key credential (n8n/create-test-credential.sh) and one :free model.
const OPENROUTER_TEST_CRED = { openRouterApi: { id: "orTestKey0000001", name: "OpenRouter test" } };
const TEST_FREE_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";

const webhook = (path, x = 0) => ({ id: path + "-hook", name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2,
  position: [x, 0], webhookId: path, parameters: { httpMethod: "POST", path, responseMode: "responseNode", options: {} } });
const code = (name, jsCode, x, y = 0) => ({ id: name.toLowerCase().replace(/\W+/g, "-"), name, type: "n8n-nodes-base.code",
  typeVersion: 2, position: [x, y], parameters: { jsCode } });
const ifTrue = (name, field, x, y = 0) => ({ id: name.toLowerCase().replace(/\W+/g, "-"), name, type: "n8n-nodes-base.if", typeVersion: 2,
  position: [x, y], parameters: { conditions: { options: { caseSensitive: true, typeValidation: "loose" }, combinator: "and",
    conditions: [{ id: "c-" + field, leftValue: `={{ $json.${field} }}`, rightValue: true,
      operator: { type: "boolean", operation: "true", singleValue: true } }] }, options: {} } });
const openrouter = (name, method, url, bodyField, timeout, x, y = 0) => ({ id: name.toLowerCase().replace(/\W+/g, "-"), name,
  type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [x, y], credentials: OPENROUTER_CRED, onError: "continueRegularOutput",
  parameters: { method, url, authentication: "predefinedCredentialType", nodeCredentialType: "openRouterApi",
    ...(bodyField ? { sendBody: true, specifyBody: "json", jsonBody: `={{ JSON.stringify($json.${bodyField}) }}` } : {}),
    options: { timeout } } });
const respond = (x) => ({ id: "respond", name: "Respond", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: [x, 0],
  parameters: { respondWith: "json", responseBody: "={{ JSON.stringify($json.reply) }}", options: { responseCode: "={{ $json.http_status || 200 }}" } } });
const schedule = (rule, x = 0) => ({ id: "schedule", name: "Schedule", type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2,
  position: [x, 0], parameters: { rule: { interval: [rule] } } });

function connect(pairs) {
  const c = {};
  for (const [from, to, output = 0] of pairs) {
    c[from] = c[from] || { main: [] };
    while (c[from].main.length <= output) c[from].main.push([]);
    c[from].main[output].push({ node: to, type: "main", index: 0 });
  }
  return c;
}
const workflow = (id, name, nodes, pairs, settings = {}) => ({ id, name, active: true, nodes, connections: connect(pairs),
  settings: { executionOrder: "v1", timezone: "Europe/Paris", saveDataSuccessExecution: "all", ...settings }, pinData: {} });
const save = (file, wf) => writeFileSync(join(OUT, file), JSON.stringify(wf, null, 1) + "\n");

// Test twin of a workflow: same code, but it talks to grocy-test and listens on <path>-test.
const toTest = (wf, id) => {
  const twin = structuredClone({ ...wf, id, name: wf.name + " (TEST: grocy-test)" });
  for (const n of twin.nodes) {
    if (n.type === "n8n-nodes-base.webhook") { n.parameters.path += "-test"; n.webhookId += "-test"; }
    if (n.parameters.jsCode) n.parameters.jsCode = n.parameters.jsCode.replaceAll("http://grocy/api", "http://grocy-test/api")
      .replace(/(localhost:5678\/webhook\/[a-z-]+)"/g, '$1-test"');
    if (typeof n.parameters.url === "string") n.parameters.url = n.parameters.url.replaceAll("http://grocy/api", "http://grocy-test/api");
    if (n.parameters.jsCode) n.parameters.jsCode = n.parameters.jsCode.replace("const TWIN = false;", "const TWIN = true;")
      .replace(/"[a-z0-9-]+\/[a-zA-Z0-9.:_-]+:free"/g, JSON.stringify(TEST_FREE_MODEL));
    if (n.credentials && n.credentials.openRouterApi) n.credentials = structuredClone(OPENROUTER_TEST_CRED);
  }
  const text = JSON.stringify(twin);
  if (text.includes("http://grocy/")) throw new Error(id + " still points at the real Grocy");
  if (text.includes(OPENROUTER_CRED.openRouterApi.id)) throw new Error(id + " still uses the app OpenRouter credential");
  return twin;
};
const saveWithTest = (file, wf, testId) => {
  save(file, wf);
  save(file.replace(/\.json$/, "-test.json"), toTest(wf, testId));
};

const rules = JSON.stringify(JSON.parse(read("shelf-life", "rules-fr.json")));
const notesEn = JSON.stringify(JSON.parse(read("shelf-life", "notes-en.json")));
const providersLib = read("shelf-life", "providers-lib.js");
saveWithTest("shelf-life.json", workflow("shelfLife0001", "Kitchen: shelf-life estimate", [
  webhook("shelf-life"),
  code("Prepare", read("shelf-life", "prepare.js").replace("/*@RULES@*/null", rules).replace("/*@NOTES_EN@*/null", notesEn), 220),
  ifTrue("Needs model?", "needs_model", 440),
  openrouter("Quota", "GET", "https://openrouter.ai/api/v1/key", null, 8000, 660, -120),
  code("Plan", read("shelf-life", "plan.js"), 880, -120),
  code("Preferred", providersLib + read("shelf-life", "preferred.js"), 1100, -120),
  ifTrue("Use OpenRouter?", "use_openrouter", 1320, -120),
  openrouter("OpenRouter", "POST", "https://openrouter.ai/api/v1/chat/completions", "openrouter_body", 20000, 1540, -240),
  code("Models", providersLib + read("shelf-life", "models.js"), 1760, -120),
  code("Write back", read("shelf-life", "write.js"), 1980, 0),
  respond(2200),
], [
  ["Webhook", "Prepare"], ["Prepare", "Needs model?"], ["Needs model?", "Quota", 0], ["Needs model?", "Write back", 1],
  ["Quota", "Plan"], ["Plan", "Preferred"], ["Preferred", "Use OpenRouter?"], ["Use OpenRouter?", "OpenRouter", 0], ["Use OpenRouter?", "Models", 1],
  ["OpenRouter", "Models"], ["Models", "Write back"], ["Write back", "Respond"],
]), "shelfLifeTest0001");

saveWithTest("shelf-life-retry.json", workflow("shelfLifeRetry0001", "Kitchen: shelf-life retry and archive", [
  schedule({ field: "minutes", minutesInterval: 5 }),
  code("Retry pending", read("scheduled", "retry.js"), 220),
], [["Schedule", "Retry pending"]], { saveDataSuccessExecution: "none" }), "shelfLifeRetryTest0001");

const parseLib = read("receipts", "parse-lib.js");
const matchLib = read("receipts", "match-lib.js");
saveWithTest("receipt-parse.json", workflow("receiptParse0001", "Kitchen: receipt parse", [
  webhook("receipt-parse"),
  code("Parse", parseLib + read("receipts", "parse.js"), 220),
  ifTrue("Needs repair?", "needs_repair", 440),
  openrouter("Quota", "GET", "https://openrouter.ai/api/v1/key", null, 8000, 660, -120),
  code("Repair plan", read("receipts", "repair-plan.js"), 880, -120),
  ifTrue("Use OpenRouter?", "use_openrouter", 1100, -120),
  openrouter("OpenRouter repair", "POST", "https://openrouter.ai/api/v1/chat/completions", "repair_body", 45000, 1320, -240),
  code("Match", matchLib + read("receipts", "match.js"), 1540, 0),
  respond(1760),
], [
  ["Webhook", "Parse"], ["Parse", "Needs repair?"], ["Needs repair?", "Quota", 0], ["Needs repair?", "Match", 1],
  ["Quota", "Repair plan"], ["Repair plan", "Use OpenRouter?"], ["Use OpenRouter?", "OpenRouter repair", 0],
  ["Use OpenRouter?", "Match", 1], ["OpenRouter repair", "Match"], ["Match", "Respond"],
]), "receiptParseTest0001");

saveWithTest("receipt-commit.json", workflow("receiptCommit0001", "Kitchen: receipt commit", [
  webhook("receipt-commit"),
  code("Commit", matchLib + read("receipts", "commit.js"), 220),
  respond(440),
], [["Webhook", "Commit"], ["Commit", "Respond"]]), "receiptCommitTest0001");

// The shopping inbox reader (17-33): texts the inbox rules cannot read become items; it never writes Grocy.
const inboxRespond = { ...respond(880), id: "respond-inbox" };
saveWithTest("shopping-inbox.json", { ...workflow("shoppingInbox0001", "Kitchen: shopping inbox", [
  webhook("shopping-inbox"),
  code("Prepare", read("shopping-inbox", "prepare.js"), 220),
  ifTrue("Needs model?", "needs_model", 440),
  openrouter("OpenRouter", "POST", "https://openrouter.ai/api/v1/chat/completions", "openrouter_body", 20000, 660, -120),
  code("Reply", read("shopping-inbox", "reply.js"), 880, -120),
  inboxRespond,
], [
  ["Webhook", "Prepare"], ["Prepare", "Needs model?"], ["Needs model?", "OpenRouter", 0], ["Needs model?", "Respond", 1],
  ["OpenRouter", "Reply"], ["Reply", "Respond"],
]), active: false }, "shoppingInboxTest0001");

// Accepts the older TikTok secret and webhook.secret (what the iOS share extension sends).
const tiktok = { ...workflow("tiktokRecipe0001", "TikTok -> Grocy recipe", [
  { id: "a1", name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], webhookId: "tiktok-recipe",
    parameters: { httpMethod: "POST", path: "tiktok-recipe", responseMode: "onReceived", options: {
      responseData: "{\"ok\":true,\"message\":\"Import en cours, la recette apparaît dans Grocy d'ici quelques minutes.\"}" } } },
  { ...code("Read TikTok", read("tiktok", "read.js"), 220), id: "a2" },
  { id: "a3", name: "Continue?", type: "n8n-nodes-base.if", typeVersion: 2, position: [440, 0], parameters: {
    conditions: { options: { caseSensitive: true, typeValidation: "loose" }, combinator: "and", conditions: [{ id: "c1",
      leftValue: "={{ $json.stop }}", rightValue: false, operator: { type: "boolean", operation: "false", singleValue: true } }] },
    options: {} } },
  { id: "a4", name: "Parse recipe (OpenRouter)", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [660, -100],
    credentials: OPENROUTER_CRED, parameters: { method: "POST", url: "https://openrouter.ai/api/v1/chat/completions",
      authentication: "predefinedCredentialType", nodeCredentialType: "openRouterApi", sendBody: true, specifyBody: "json",
      jsonBody: "={{ JSON.stringify($json.llmRequest) }}", options: { timeout: 300000 } } },
  { ...code("Create in Grocy", read("tiktok", "create.js"), 880, -100), id: "a5" },
  { id: "a6", name: "Stop", type: "n8n-nodes-base.noOp", typeVersion: 1, position: [660, 100], parameters: {} },
  { id: "a7", name: "Download thumbnail", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [1100, -100],
    onError: "continueRegularOutput", parameters: { url: "={{ $json.thumbnailUrl }}", sendHeaders: true,
      headerParameters: { parameters: [{ name: "User-Agent", value: "Mozilla/5.0" }] },
      options: { response: { response: { responseFormat: "file", outputPropertyName: "data" } } } } },
  { id: "a8", name: "Upload photo", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [1320, -100],
    onError: "continueRegularOutput", parameters: { method: "PUT",
      url: "=http://grocy/api/files/recipepictures/{{ $('Create in Grocy').item.json.fileNameB64 }}", sendHeaders: true,
      headerParameters: { parameters: [{ name: "GROCY-API-KEY", value: "__GROCY_API_KEY__" }] },
      sendBody: true, contentType: "binaryData", inputDataFieldName: "data", options: {} } },
  { ...code("Link photo", read("tiktok", "link.js"), 1540, -100), id: "a9" },
], [
  ["Webhook", "Read TikTok"], ["Read TikTok", "Continue?"], ["Continue?", "Parse recipe (OpenRouter)", 0], ["Continue?", "Stop", 1],
  ["Parse recipe (OpenRouter)", "Create in Grocy"], ["Create in Grocy", "Download thumbnail"],
  ["Download thumbnail", "Upload photo"], ["Upload photo", "Link photo"],
]), settings: { executionOrder: "v1" } };
saveWithTest("tiktok-recipe.json", tiktok, "tiktokRecipeTest0001");

save("openrouter-quota.json", {
  ...workflow("openrouterQuota0001", "Tool: OpenRouter free quota", [
    { id: "manual", name: "Manual", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0], parameters: {} },
    openrouter("Quota", "GET", "https://openrouter.ai/api/v1/key", null, 8000, 220),
  ], [["Manual", "Quota"]]),
  active: false,
});
console.log("templates written to", OUT);
