// Finish (19-SPEC 7.5): links the uploaded photo, then the name, import_draft v2 and status ready; any error to failed.
const plan = $("Draft").first().json;
const upload = $input.first().json;
const helpers = this.helpers;
if (plan.done) return [{ json: plan }];
try {
  const photo = plan.has_photo && !upload.error ? plan.photo.file_name : null;
  if (photo) await grocyCall(helpers, "PUT", "/objects/recipes/" + plan.recipe_id, { picture_file_name: photo });
  if (plan.name) await grocyCall(helpers, "PUT", "/objects/recipes/" + plan.recipe_id, { name: plan.name });
  await setFields(helpers, plan.recipe_id, { import_status: "ready", import_error: "", import_draft: JSON.stringify(plan.draft),
    import_raw: plan.raw, source_author: plan.draft.source.author || "" });
  return [{ json: { ok: true, recipe_id: plan.recipe_id, import_status: "ready", parser: plan.parser, photo, lines: plan.lines, steps: plan.steps } }];
} catch (e) {
  const error = await markFailed(helpers, plan.recipe_id, stageOf(e.message, "write"), e.message, plan.raw);
  return [{ json: { ok: false, recipe_id: plan.recipe_id, import_status: "failed", import_error: error } }];
}
