import { test } from "node:test";
import assert from "node:assert/strict";
import { loadLib, source } from "./load.mjs";

const { findRecipe, microdata, heuristic, readableText, pageMeta, isoMinutes } =
  loadLib(["html-lib.js"], ["findRecipe", "microdata", "heuristic", "readableText", "pageMeta", "isoMinutes"]);
const ld = (data) => "<script type=\"application/ld+json\">" + JSON.stringify(data) + "</script>";
const base = { name: "Soupe", recipeIngredient: ["1 l d'eau", "2 carottes"], recipeInstructions: "Cuire." };

test("JSON-LD as a plain object, an array, an @graph and a nested mainEntity", () => {
  assert.equal(findRecipe(ld({ "@type": "Recipe", ...base })).name, "Soupe");
  assert.equal(findRecipe(ld([{ "@type": "WebSite" }, { "@type": "Recipe", ...base }])).name, "Soupe");
  assert.equal(findRecipe(ld({ "@graph": [{ "@type": "WebPage" }, { "@type": ["Recipe"], ...base }] })).name, "Soupe");
  assert.equal(findRecipe(ld({ "@type": "WebPage", mainEntity: { "@type": "Recipe", ...base } })).name, "Soupe");
  assert.equal(findRecipe(ld({ "@type": "http://schema.org/Recipe", ...base })).name, "Soupe");
});

test("malformed JSON-LD blocks are skipped, a page without a Recipe gives null", () => {
  assert.equal(findRecipe("<script type=\"application/ld+json\">{ nope</script>" + ld({ "@type": "Recipe", ...base })).name, "Soupe");
  assert.equal(findRecipe(ld({ "@type": "Article", name: "News" })), null);
  assert.equal(findRecipe("<html><body>no data</body></html>"), null);
});

test("instructions as a string, HowToStep list and HowToSection", () => {
  assert.deepEqual(findRecipe(ld({ "@type": "Recipe", ...base, recipeInstructions: "Couper.\nCuire." })).steps,
    [{ section: "", text: "Couper." }, { section: "", text: "Cuire." }]);
  assert.deepEqual(findRecipe(ld({ "@type": "Recipe", ...base, recipeInstructions: [{ "@type": "HowToStep", text: "A" }, { "@type": "HowToStep", name: "B" }] })).steps,
    [{ section: "", text: "A" }, { section: "", text: "B" }]);
  assert.deepEqual(findRecipe(ld({ "@type": "Recipe", ...base, recipeInstructions: [{ "@type": "HowToSection", name: "Pâte",
    itemListElement: [{ "@type": "HowToStep", text: "<p>Mélanger</p>" }] }] })).steps, [{ section: "Pâte", text: "Mélanger" }]);
});

test("yield, durations and image forms", () => {
  const r = (extra) => findRecipe(ld({ "@type": "Recipe", ...base, ...extra }));
  assert.equal(r({ recipeYield: "4" }).servings, 4);
  assert.deepEqual([r({ recipeYield: "4 servings" }).servings, r({ recipeYield: "4 servings" }).servings_text], [4, "4 servings"]);
  assert.deepEqual([r({ recipeYield: ["4", "4 pers."] }).servings, r({ recipeYield: ["4", "4 pers."] }).servings_text], [4, "4 pers."]);
  assert.equal(isoMinutes("PT1H15M"), 75);
  assert.equal(isoMinutes("PT20M"), 20);
  assert.equal(isoMinutes(""), null);
  assert.equal(r({ image: "https://x/a.jpg" }).image_url, "https://x/a.jpg");
  assert.equal(r({ image: ["https://x/b.jpg", "https://x/c.jpg"] }).image_url, "https://x/b.jpg");
  assert.equal(r({ image: { "@type": "ImageObject", url: "https://x/d.jpg" } }).image_url, "https://x/d.jpg");
});

test("microdata and heuristic lists on the saved pages", () => {
  const md = microdata(source("test/pages/microdata.html"));
  assert.equal(md.name, "Banana bread");
  assert.equal(md.lines.length, 4);
  assert.equal(md.steps.length, 3);
  const h = heuristic(source("test/pages/headings.html"));
  assert.deepEqual(h.lines, ["1 pâte feuilletée", "4 pommes", "30 g de beurre", "2 c.à.s. de sucre"]);
  assert.equal(h.steps.length, 3);
  const en = heuristic("<h3>Ingredients</h3><ul><li>2 eggs</li><li>1 cup milk</li></ul><h3>Method</h3><p>Whisk.</p><p>Fry.</p>");
  assert.deepEqual([en.lines.length, en.steps.map((s) => s.text)], [2, ["Whisk.", "Fry."]]);
  const de = heuristic("<div class=\"recipe-zutaten\"><ul><li>200 g Mehl</li><li>2 Eier</li></ul></div><div class=\"zubereitung\"><ol><li>Mischen.</li></ol></div>");
  assert.deepEqual([de.lines.length, de.steps.length], [2, 1]);
});

test("readable text drops scripts, menus, footers and cookie banners and is capped", () => {
  const text = readableText(source("test/pages/headings.html") + "<script>var x = 'secret code';</script>");
  assert.match(text, /Tarte fine aux pommes/);
  assert.match(text, /- 30 g de beurre/);
  for (const gone of ["cookies", "Accueil", "Le blog de Jo\n", "secret code", "©"]) assert.ok(!text.includes(gone), gone);
  assert.equal(readableText("<p>" + "a".repeat(20000) + "</p>").length, 15000);
  assert.equal(pageMeta(source("test/pages/headings.html")).image_url, "/media/tarte.jpg");
});
