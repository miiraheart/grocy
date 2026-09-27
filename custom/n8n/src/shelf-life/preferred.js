const plan = $input.first().json;
const chosen = plan.ctx && plan.ctx.provider;
let preferred = null;
const preferred_errors = [];
if (chosen && chosen !== "openrouter") {
  const r = await callProvider(this.helpers, plan, chosen);
  if (r.result) preferred = r.result;
  else preferred_errors.push(r.error);
}
return [{ json: { ...plan, use_openrouter: plan.use_openrouter && !preferred, preferred, preferred_errors } }];
