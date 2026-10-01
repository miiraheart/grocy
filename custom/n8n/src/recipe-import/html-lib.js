// Recipe page reading without a DOM: JSON-LD Recipe, microdata, heuristic lists, readable text. Plain functions for Code nodes.
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", eacute: "é", egrave: "è", agrave: "à",
  ccedil: "ç", ecirc: "ê", ocirc: "ô", icirc: "î", ucirc: "û", acirc: "â", rsquo: "\u2019", lsquo: "\u2018", hellip: "\u2026",
  frac12: "½", frac14: "¼", frac34: "¾", deg: "°", laquo: "«", raquo: "»", ndash: "-", mdash: "-", oelig: "œ" };
const decode = (s) => String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
  if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n ? String.fromCodePoint(n) : ""; }
  return ENTITIES[e.toLowerCase()] !== undefined ? ENTITIES[e.toLowerCase()] : m;
});
const stripTags = (s) => decode(String(s || "").replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/?(a|span|b|i|em|strong|abbr|sup|sub|small|u|mark|font)\b[^>]*>/gi, "").replace(/<[^>]*>/g, " "));
const oneLine = (s) => stripTags(s).replace(/\s+/g, " ").trim();
const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const isType = (node, type) => node && typeof node === "object" && asArray(node["@type"]).some((t) => String(t).replace(/^.*[/#]/, "") === type);

function isoMinutes(v) {
  const m = String(v || "").match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m || !(m[1] || m[2] || m[3])) return null;
  return (Number(m[1]) || 0) * 1440 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}
function readYield(v) {
  const texts = asArray(v).map((x) => oneLine(typeof x === "object" ? x.value || x.name || "" : x)).filter(Boolean);
  const withNumber = texts.find((t) => /\d/.test(t));
  const n = withNumber ? Number(withNumber.match(/\d+(?:[.,]\d+)?/)[0].replace(",", ".")) : null;
  const text = texts.find((t) => /\D/.test(t)) || withNumber || null;
  return { servings: n, servings_text: text };
}
function imageUrl(v) {
  const first = asArray(v)[0];
  if (!first) return null;
  if (typeof first === "string") return first;
  return first.url || first.contentUrl || first["@id"] || null;
}
function authorName(v) {
  const first = asArray(v)[0];
  return first ? oneLine(typeof first === "string" ? first : first.name || "") || null : null;
}
function listWords(v) {
  return asArray(v).flatMap((x) => String(typeof x === "object" ? x.name || "" : x).split(",")).map((t) => oneLine(t).toLowerCase()).filter(Boolean);
}

function instructionSteps(v, section = "") {
  const out = [];
  for (const item of asArray(v)) {
    if (typeof item === "string") {
      const text = stripTags(item);
      const parts = text.split(/\n+/).map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
      for (const p of parts) out.push({ section, text: p });
    } else if (isType(item, "HowToSection")) {
      out.push(...instructionSteps(item.itemListElement || item.steps, oneLine(item.name)));
    } else if (item && typeof item === "object") {
      if (item.itemListElement) out.push(...instructionSteps(item.itemListElement, section));
      else { const text = oneLine(item.text || item.name || item.description); if (text) out.push({ section, text }); }
    }
  }
  return out;
}

function findRecipeNode(data, depth = 0) {
  if (!data || typeof data !== "object" || depth > 6) return null;
  if (Array.isArray(data)) { for (const x of data) { const r = findRecipeNode(x, depth + 1); if (r) return r; } return null; }
  if (isType(data, "Recipe")) return data;
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item"]) {
    const r = findRecipeNode(data[key], depth + 1);
    if (r) return r;
  }
  return null;
}

// The schema.org Recipe of the page as a partial draft, or null.
function findRecipe(html) {
  const blocks = String(html).matchAll(/<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, body] of blocks) {
    let data;
    try { data = JSON.parse(body.trim().replace(/^<!\[CDATA\[|\]\]>$/g, "").replace(/[\u0000-\u001F]+/g, " ")); } catch (e) { continue; }
    const r = findRecipeNode(data);
    if (!r) continue;
    const lines = asArray(r.recipeIngredient || r.ingredients).map(oneLine).filter(Boolean);
    const tags = [...listWords(r.recipeCategory), ...listWords(r.recipeCuisine), ...listWords(r.keywords)];
    return { name: oneLine(r.name) || null, lines, steps: instructionSteps(r.recipeInstructions),
      ...readYield(r.recipeYield), times: { prep: isoMinutes(r.prepTime), cook: isoMinutes(r.cookTime), lead: null },
      image_url: imageUrl(r.image), author: authorName(r.author), tags };
  }
  return null;
}

// The element that starts at `start` (an opening tag) up to its matching closing tag, as inner HTML.
function innerAt(html, start) {
  const open = html.slice(start).match(/^<([a-z][a-z0-9]*)\b[^>]*>/i);
  if (!open) return "";
  const tag = open[1].toLowerCase();
  if (/^(img|br|meta|link|input|hr|source)$/.test(tag) || open[0].endsWith("/>")) return "";
  const re = new RegExp("<(/?)" + tag + "\\b[^>]*>", "gi");
  re.lastIndex = start + open[0].length;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start + open[0].length, m.index);
  }
  return html.slice(start + open[0].length);
}
const listItems = (html) => [...String(html).matchAll(/<li\b[^>]*>/gi)].map((m) => oneLine(innerAt(html, m.index))).filter(Boolean);
const attr = (tag, name) => { const m = tag.match(new RegExp("\\b" + name + "\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)", "i")); return m ? decode(m[1].replace(/^["']|["']$/g, "")) : null; };

function microdata(html) {
  const itemprop = (names) => [...html.matchAll(new RegExp("<[a-z][^>]*itemprop=[\"']?(?:" + names + ")[\"'\\s>][^>]*>", "gi"))];
  const ingredients = itemprop("recipeIngredient|ingredients").map((m) => attr(m[0], "content") || oneLine(innerAt(html, m.index))).filter(Boolean);
  if (!ingredients.length) return null;
  const steps = itemprop("recipeInstructions").flatMap((m) => {
    const inner = innerAt(html, m.index);
    const items = listItems(inner);
    return (items.length ? items : stripTags(inner).split(/\n+/).map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean)).map((text) => ({ section: "", text }));
  });
  const scope = html.search(/itemtype=["']?https?:\/\/schema\.org\/Recipe/i);
  const nameTag = scope >= 0 ? html.slice(scope).match(/<[a-z][^>]*itemprop=["']?name["'\s>][^>]*>/i) : null;
  const name = nameTag ? attr(nameTag[0], "content") || oneLine(innerAt(html.slice(scope), nameTag.index)) : null;
  const yieldTag = html.match(/<[a-z][^>]*itemprop=["']?recipeYield["'\s>][^>]*>/i);
  const y = yieldTag ? readYield(attr(yieldTag[0], "content") || oneLine(innerAt(html, yieldTag.index))) : { servings: null, servings_text: null };
  return { name: name || null, lines: ingredients, steps, ...y, times: { prep: null, cook: null, lead: null }, image_url: null, author: null, tags: [] };
}

// Lists under ingredient and method headings, then containers whose class names say so (fr, en, de).
const INGREDIENT_WORDS = /ingr[eé]dients?|zutaten/i;
const METHOD_WORDS = /pr[eé]paration|proc[eé]dures?|[eé]tapes|instructions?|method|directions|zubereitung|steps/i;
function heuristic(html) {
  const found = { lines: [], steps: [] };
  const headings = [...html.matchAll(/<h([1-6])\b[^>]*>/gi)].map((m) => ({ index: m.index, text: oneLine(innerAt(html, m.index)) }));
  headings.forEach((h, i) => {
    const kind = h.text.split(" ").length <= 4 && !/\d/.test(h.text) ? (INGREDIENT_WORDS.test(h.text) ? "lines" : METHOD_WORDS.test(h.text) ? "steps" : null) : null;
    if (!kind || found[kind].length) return;
    const end = i + 1 < headings.length ? headings[i + 1].index : html.length;
    const part = html.slice(h.index, end);
    let items = listItems(part);
    if (!items.length && kind === "steps") items = [...part.matchAll(/<p\b[^>]*>/gi)].map((m) => oneLine(innerAt(part, m.index))).filter(Boolean);
    found[kind] = items;
  });
  for (const [kind, words] of [["lines", INGREDIENT_WORDS], ["steps", METHOD_WORDS]]) {
    if (found[kind].length) continue;
    const boxes = [...html.matchAll(/<(?:div|section|ul|ol)\b[^>]*class=["'][^"']*["'][^>]*>/gi)].filter((m) => words.test(attr(m[0], "class") || ""));
    const best = boxes.map((m) => listItems(innerAt(html, m.index))).sort((a, b) => b.length - a.length)[0];
    if (best) found[kind] = best;
  }
  return { lines: found.lines, steps: found.steps.map((text) => ({ section: "", text: text.replace(/^\d{1,2}\s*[.)]\s+/, "") })) };
}

function pageMeta(html) {
  const meta = (key) => { const m = html.match(new RegExp("<meta[^>]+(?:property|name)=[\"']" + key + "[\"'][^>]*>", "i")); return m ? attr(m[0], "content") : null; };
  const title = meta("og:title") || oneLine((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  return { title: title || null, image_url: meta("og:image"), author: meta("author") };
}

// The text a person reads on the page, without scripts, menus, footers or cookie banners, at most 15000 chars.
function readableText(html) {
  let s = String(html).replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(head|script|style|noscript|svg|nav|header|footer|aside|form|iframe|template)\b[\s\S]*?<\/\1>/gi, " ");
  for (let guard = 0; guard < 20; guard++) {
    const m = s.match(/<[a-z][a-z0-9]*\b[^>]*(?:id|class)=["'][^"']*(?:cookie|consent|gdpr|didomi|onetrust)[^"']*["'][^>]*>/i);
    if (!m) break;
    const inner = innerAt(s, m.index);
    s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length + inner.length).replace(/^<\/[a-z0-9]+>/i, "");
  }
  s = s.replace(/<li\b[^>]*>/gi, "\n- ").replace(/<\/(p|div|h[1-6]|li|ul|ol|tr|section|article)>/gi, "\n");
  const text = stripTags(s).split("\n").map((l) => l.replace(/[ \t\u00A0]+/g, " ").trim()).filter(Boolean).join("\n");
  return text.slice(0, 15000);
}
