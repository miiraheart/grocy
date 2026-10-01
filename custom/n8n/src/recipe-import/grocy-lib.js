// Grocy API calls from the recipe-import Code nodes (toTest swaps the base URL for grocy-test).
const GROCY = "http://grocy/api";
const GROCY_KEY = "__GROCY_API_KEY__";

async function grocyCall(helpers, method, path, body) {
  return helpers.httpRequest({ method, url: GROCY + path, json: true, timeout: 20000,
    headers: { "GROCY-API-KEY": GROCY_KEY }, ...(body === undefined ? {} : { body }) });
}
const setFields = (helpers, id, fields) => grocyCall(helpers, "PUT", "/userfields/recipes/" + id, fields);

// import_error is a single line field: "<stage>: <message>", 250 chars at most.
async function markFailed(helpers, id, stage, message, raw) {
  const text = String(message || "error").replace(/^(resolve|read|extract|transcribe|parse|write):\s*/, "");
  const fields = { import_status: "failed", import_error: (stage + ": " + text).replace(/\s+/g, " ").slice(0, 250) };
  if (raw) fields.import_raw = String(raw).slice(0, 60000);
  await setFields(helpers, id, fields);
  return fields.import_error;
}
const stageOf = (message, fallback) => (String(message).match(/^(resolve|read|extract|transcribe|parse|write):/) || [])[1] || fallback;
