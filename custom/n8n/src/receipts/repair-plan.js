const QUOTA_RESERVE = 15;
const parsed = $("Parse").first().json;
const quota = $input.first().json || {};
const daily = quota.data && quota.data.free_model_daily_requests;
const remaining = daily && typeof daily.remaining === "number" ? daily.remaining : null;
const use_openrouter = !quota.error && (remaining === null || remaining > QUOTA_RESERVE);
return [{ json: { ...parsed, use_openrouter, quota_remaining: remaining } }];
