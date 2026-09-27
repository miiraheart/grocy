const plan = $("Preferred").first().json;
const ctx = plan.ctx || {};
const only = ctx.provider_only ? ctx.provider : null;
const alreadyTried = ctx.provider && ctx.provider !== "openrouter" ? ctx.provider : null;
const wants = (p) => (!only || only === p) && p !== alreadyTried;
const errors = [...(plan.preferred_errors || [])];

let result = plan.preferred || null;
let routerReply = null;
if (!result && plan.use_openrouter) {
  try { routerReply = $("OpenRouter").first().json; } catch (e) { routerReply = null; }
}

if (routerReply) {
  const content = routerReply.choices && routerReply.choices[0] && routerReply.choices[0].message && routerReply.choices[0].message.content;
  result = content ? validate(content) : null;
  if (result) result.source = "openrouter:" + (routerReply.model || "free");
  else errors.push("openrouter: " + JSON.stringify(routerReply.error || routerReply).slice(0, 200));
} else if (!result && !plan.use_openrouter && wants("openrouter")) {
  errors.push("openrouter skipped (quota " + plan.quota_remaining + ")");
}

for (const id of ["groq", "mistral", "gemini"]) {
  if (result || !wants(id) || !hasKey(id)) continue;
  const r = await callProvider(this.helpers, plan, id);
  if (r.result) result = r.result;
  else errors.push(r.error);
}

if (!result && wants("ollama")) {
  const r = await callProvider(this.helpers, plan, "ollama");
  if (r.result) result = r.result;
  else errors.push(r.error);
}

const { openrouter_body, groq_body, mistral_body, gemini_body, ollama_body, preferred, preferred_errors, ...rest } = plan;
return [{ json: { ...rest, result, model_errors: errors } }];
