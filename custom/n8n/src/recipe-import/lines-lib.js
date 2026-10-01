// Ingredient line parser and pasted text splitter. Same results as the app's IngredientLineParser on the shared
// corpus test/ingredient-lines.json (19-SPEC 7.9). Plain functions: build.mjs pastes this file into Code nodes.
const LINE_INVISIBLE = /[⁣⁢​‌‍﻿]/g;
const LINE_SPACES = /[   \t]/g;
const LINE_BULLETS = ["-", "*", "•", "·", "–", "—"];
const WORD_START = "(?<![\\p{L}\\p{N}_])";
const WORD_END = "(?![\\p{L}\\p{N}_])";
const OPTIONAL_RE = new RegExp(",?\\s*" + WORD_START + "(facultatif|facultative|optionnel|optionnelle|optional)" + WORD_END, "giu");
const TASTE_RE = new RegExp(WORD_START + "(au go[uû]t|selon (?:le )?go[uû]t|[àa] volont[ée]|to taste|as needed)" + WORD_END, "iu");
const VULGAR = { "½": 0.5, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 0.25, "¾": 0.75, "⅕": 0.2, "⅖": 0.4,
  "⅗": 0.6, "⅘": 0.8, "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875 };
const NUMBER_WORDS = { un: [1, false], une: [1, false], one: [1, false], a: [1, true], an: [1, true], deux: [2, false],
  two: [2, false], trois: [3, false], three: [3, false], quatre: [4, false], four: [4, false] };
const UNIT_ALIASES = {
  g: ["g", "gr", "gramme", "grammes", "gram", "grams"],
  kg: ["kg", "kilo", "kilos", "kilogramme", "kilogrammes", "kilogram", "kilograms"],
  ml: ["ml", "millilitre", "millilitres", "milliliter", "milliliters"],
  cl: ["cl", "centilitre", "centilitres"],
  dl: ["dl", "decilitre", "decilitres"],
  l: ["l", "litre", "litres", "liter", "liters"],
  tsp: ["tsp", "tsps", "teaspoon", "teaspoons", "cac", "c.a.c.", "c.a.c", "c. a c.", "c. a c", "c a c", "cc",
    "c.c.", "cuillere a cafe", "cuilleres a cafe", "cuil. a cafe", "c. a cafe"],
  tbsp: ["tbsp", "tbsps", "tbs", "tablespoon", "tablespoons", "cas", "c.a.s.", "c.a.s", "c. a s.", "c. a s",
    "c a s", "cs", "c.s.", "cuillere a soupe", "cuilleres a soupe", "cuil. a soupe", "c. a soupe"],
  cup: ["cup", "cups", "tasse", "tasses"],
  oz: ["oz", "ounce", "ounces", "once", "onces"],
  lb: ["lb", "lbs", "pound", "pounds"],
  fl_oz: ["fl oz", "fl. oz", "fl.oz", "fl. oz.", "fluid ounce", "fluid ounces"],
  pinch: ["pincee", "pincees", "pinch", "pinches"],
  clove: ["gousse", "gousses", "clove", "cloves"],
  bunch: ["botte", "bottes", "bouquet", "bouquets", "bunch", "bunches"],
  can: ["boite", "boites", "can", "cans", "conserve", "conserves", "tin", "tins"],
  sachet: ["sachet", "sachets", "packet", "packets"],
  slice: ["tranche", "tranches", "slice", "slices"],
  piece: ["piece", "pieces", "pc", "pcs"],
};
const SORTED_ALIASES = Object.entries(UNIT_ALIASES).flatMap(([key, list]) => list.map((alias) => ({ alias, key })))
  .sort((a, b) => b.alias.length - a.alias.length || (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));

const isLetterOrNumber = (c) => /[\p{L}\p{N}]/u.test(c);
const dropSpaces = (s) => s.replace(/^ +/, "");
const leadingDigits = (s) => s.match(/^[0-9]*/)[0];
const foldChar = (c) => (c.toLowerCase().normalize("NFD")[0] || c);

function cleanLine(raw) {
  let text = String(raw).replace(LINE_INVISIBLE, "").replace(LINE_SPACES, " ").split(" ").filter(Boolean).join(" ");
  if (LINE_BULLETS.includes(text[0]) && text[1] === " ") text = text.slice(2);
  return text;
}
const tidy = (text) => String(text).split(/\s+/).filter(Boolean).join(" ").replace(/^[ ,;:]+|[ ,;:]+$/g, "");

function removingOptional(text) {
  OPTIONAL_RE.lastIndex = 0;
  if (!OPTIONAL_RE.test(text)) return [text, false];
  return [tidy(text.replace(OPTIONAL_RE, " ")), true];
}

function slashFraction(text) {
  const top = leadingDigits(text);
  let rest = text.slice(top.length);
  if (!top || (rest[0] !== "/" && rest[0] !== "⁄")) return null;
  rest = rest.slice(1);
  const bottom = leadingDigits(rest);
  if (!bottom) return null;
  return [Number(top), Number(bottom), rest.slice(bottom.length)];
}

function parseNumber(input) {
  const text = dropSpaces(input);
  if (VULGAR[text[0]] !== undefined) return [VULGAR[text[0]], text.slice(1)];
  const whole = leadingDigits(text);
  let rest = text.slice(whole.length);
  if ((rest[0] === "." || rest[0] === ",") && leadingDigits(rest.slice(1))) {
    const fraction = leadingDigits(rest.slice(1));
    return [Number((whole || "0") + "." + fraction), rest.slice(1 + fraction.length)];
  }
  if (!whole) return null;
  const integer = Number(whole);
  const slash = slashFraction(text);
  if (slash && slash[1] > 0) return [slash[0] / slash[1], slash[2]];
  const spaced = dropSpaces(rest);
  if (VULGAR[spaced[0]] !== undefined) return [integer + VULGAR[spaced[0]], spaced.slice(1)];
  if (spaced.length < rest.length) {
    const spacedSlash = slashFraction(spaced);
    if (spacedSlash && spacedSlash[1] > 0) return [integer + spacedSlash[0] / spacedSlash[1], spacedSlash[2]];
  }
  return [integer, rest];
}

function rangeEnd(text) {
  const trimmed = dropSpaces(text);
  for (const connector of ["-", "–", "à ", "a ", "to ", "ou ", "or "]) {
    if (!trimmed.toLowerCase().startsWith(connector)) continue;
    const found = parseNumber(trimmed.slice(connector.length));
    if (found) return found;
  }
  return null;
}

function numberWord(text) {
  const word = text.match(/^\p{L}*/u)[0];
  const entry = NUMBER_WORDS[word.toLowerCase()];
  if (!word || !entry || text[word.length] !== " ") return null;
  return [entry[0], text.slice(word.length), entry[1]];
}

function unitAt(text) {
  const trimmed = dropSpaces(text);
  const folded = Array.from(trimmed.slice(0, 24)).map(foldChar).join("");
  for (const { alias, key } of SORTED_ALIASES) {
    if (!folded.startsWith(alias)) continue;
    const next = folded[alias.length];
    if (next !== undefined && isLetterOrNumber(next) && !alias.endsWith(".")) continue;
    if (next === "'" || next === "’") continue;
    return [key, trimmed.slice(alias.length)];
  }
  return null;
}

function amountAt(text) {
  const num = parseNumber(text);
  const unit = num && unitAt(num[1]);
  return unit ? [{ quantity: num[0], unit: unit[0] }, unit[1]] : null;
}
function wholeAmount(text) {
  const found = amountAt(text);
  return found && !found[1].trim() ? found[0] : null;
}
function slashAmount(text) {
  const trimmed = dropSpaces(text);
  return trimmed[0] === "/" ? amountAt(trimmed.slice(1)) : null;
}
function sizeAmount(text) {
  const trimmed = dropSpaces(text);
  for (const word of ["de ", "of "]) {
    if (!trimmed.toLowerCase().startsWith(word)) continue;
    const found = amountAt(trimmed.slice(word.length));
    if (found) return found;
  }
  return null;
}
function strippingElision(text) {
  const trimmed = dropSpaces(text);
  for (const word of ["de ", "d'", "d’", "of "]) if (trimmed.toLowerCase().startsWith(word)) return trimmed.slice(word.length);
  return trimmed;
}

function parseLine(raw) {
  const line = { raw: String(raw), quantity: null, quantity_max: null, unit: null, name: "", note: null, optional: false, size: null, alt: [] };
  let text = cleanLine(raw);
  const notes = [];
  const lateNotes = [];
  let paren;
  while ((paren = text.match(/\(([^()]*)\)/))) {
    const content = paren[1].trim();
    text = text.slice(0, paren.index) + " " + text.slice(paren.index + paren[0].length);
    const amount = wholeAmount(content);
    if (amount) { line.alt.push(amount); continue; }
    const [rest, optional] = removingOptional(content);
    line.optional = line.optional || optional;
    if (rest) notes.push(rest);
  }
  let taste;
  while ((taste = text.match(TASTE_RE))) {
    lateNotes.push(taste[0]);
    text = text.slice(0, taste.index) + " " + text.slice(taste.index + taste[0].length);
  }
  const [withoutMarker, optional] = removingOptional(text);
  line.optional = line.optional || optional;
  let rest = withoutMarker;
  let fromWord = false;
  const num = parseNumber(rest);
  const word = num ? null : numberWord(rest);
  if (num) {
    line.quantity = num[0];
    rest = num[1];
    const range = rangeEnd(rest);
    if (range) { line.quantity_max = range[0]; rest = range[1]; }
  } else if (word && (!word[2] || unitAt(word[1]))) {
    line.quantity = word[0];
    fromWord = true;
    rest = word[1];
  }
  const unit = line.quantity !== null ? unitAt(rest) : null;
  if (unit) {
    line.unit = unit[0];
    rest = unit[1];
    if (fromWord && unit[0] === "pinch") line.quantity = null;
    const alt = slashAmount(rest);
    if (alt) { line.alt.push(alt[0]); rest = alt[1]; }
    const size = sizeAmount(rest);
    if (size) { line.size = size[0]; rest = size[1]; }
    rest = strippingElision(rest);
  }
  let name = rest;
  const comma = name.indexOf(",");
  if ((line.quantity !== null || line.unit !== null) && comma >= 0) {
    const note = tidy(name.slice(comma + 1));
    if (note) notes.push(note);
    name = name.slice(0, comma);
  }
  line.name = tidy(name);
  const allNotes = notes.concat(lateNotes).map(tidy).filter(Boolean);
  line.note = allNotes.length ? allNotes.join(", ") : null;
  return line;
}

// Pasted text to groups and steps by rules: headings, numbered steps, quantities (the app's RecipeTextSplitter, no lexicon).
const INGREDIENT_HEADINGS = ["ingredients", "ingredient", "zutaten"];
const METHOD_HEADINGS = ["preparation", "preparations", "etapes", "etape", "instructions", "steps", "directions", "method",
  "methode", "recette", "recipe", "zubereitung"];
const foldText = (s) => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "");

function headingKind(text) {
  const folded = foldText(text);
  const first = (folded.split(/[^\p{L}]+/u).filter(Boolean)[0]) || "";
  if (INGREDIENT_HEADINGS.includes(first)) return "ingredients";
  if (METHOD_HEADINGS.includes(first) && folded.split(" ").length <= 4) return "method";
  return null;
}
function numberedStep(line) {
  const m = line.match(/^(?:(?:[Ss]tep|[ÉéEe]tape)\s*\d{1,2}\s*[:.)\-]?|\d{1,2}\s*[.)])\s+/);
  const text = m ? line.slice(m[0].length).trim() : "";
  return text || null;
}
function groupHeader(line) {
  if (!line.endsWith(":") || line.split(" ").length > 6) return null;
  return tidy(line.slice(0, -1)) || null;
}

function splitText(text) {
  const draft = { name: null, servings: null, servings_text: null, times: { prep: null, cook: null, lead: null }, notes: [], groups: [], steps: [] };
  let mode = "none";
  let section = "";
  const addIngredient = (raw) => {
    const parsed = parseLine(raw);
    const parts = raw.split(",").map(tidy).filter(Boolean);
    const list = parsed.quantity === null && parsed.unit === null && parts.length > 1 && parts.every((p) => p.split(" ").length <= 3);
    if (!draft.groups.length) draft.groups.push({ name: "", lines: [] });
    for (const part of list ? parts : [raw]) draft.groups[draft.groups.length - 1].lines.push(parseLine(part));
  };
  const addStep = (raw) => { const t = tidy(raw); if (t) draft.steps.push({ section, text: t }); };
  const lines = String(text).split(/\r?\n/).map(cleanLine).filter(Boolean);
  lines.forEach((line, index) => {
    const words = line.split(" ").length;
    const kind = headingKind(line);
    if (kind && !/\d/.test(line) && words <= 3) { mode = kind; return; }
    const serves = line.match(/^(?:pour|serves|servings?|portions?|makes)\s*:?\s*(\d+)/i) || line.match(/^(\d+)\s*(?:personnes?|pers\.?|portions?|servings?|parts?)(?![\p{L}])/iu);
    if (serves) { draft.servings = Number(serves[1]); draft.servings_text = line; return; }
    const time = line.match(/^(pr[ée]paration|prep(?:aration)?|cuisson|cook(?:ing)?|repos|rest(?:ing)?)(?:\s*time)?\s*:?\s*(\d+)\s*(min(?:utes?)?|h(?:eures?|ours?)?)\.?\s*$/i);
    if (time) {
      const minutes = Number(time[2]) * (/^h/i.test(time[3]) ? 60 : 1);
      const key = /^(cuisson|cook)/i.test(time[1]) ? "cook" : /^(repos|rest)/i.test(time[1]) ? "lead" : "prep";
      draft.times[key] = minutes;
      return;
    }
    if (line.startsWith("*") || /^(note|astuce|tip)/.test(foldText(line))) { draft.notes.push(line); return; }
    const header = groupHeader(line);
    if (header && (mode !== "none" || index > 0)) {
      if (mode === "method") section = header;
      else { mode = "ingredients"; draft.groups.push({ name: header, lines: [] }); }
      return;
    }
    const step = numberedStep(line);
    if (step) { mode = "method"; addStep(step); return; }
    if (mode === "ingredients") return addIngredient(line);
    if (mode === "method") return addStep(line);
    const parsed = parseLine(line);
    if (parsed.quantity !== null && (parsed.unit !== null || words <= 5)) addIngredient(line);
    else if (index === 0 && words <= 8) draft.name = tidy(line);
    else if (draft.groups.length && words >= 3 && line.endsWith(".")) addStep(line);
  });
  draft.groups = draft.groups.filter((g) => g.lines.length);
  return draft;
}
const lineCount = (draft) => draft.groups.reduce((n, g) => n + g.lines.length, 0);
