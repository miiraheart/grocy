const GROCY = "http://grocy/api";
const created = $("Create in Grocy").first().json;
const upload = $input.first().json;
const hasImage = !!($("Download thumbnail").first().binary || {}).data;
let photo = false;
if (hasImage && !upload.error) {
  try {
    await this.helpers.httpRequest({ method: "PUT", url: GROCY + "/objects/recipes/" + created.recipeId,
      headers: { "GROCY-API-KEY": "__GROCY_API_KEY__" }, json: true, body: { picture_file_name: created.fileName } });
    photo = true;
  } catch (e) { photo = false; }
}
const { thumbnailUrl, fileName, fileNameB64, ...summary } = created;
return [{ json: { ...summary, photo } }];
