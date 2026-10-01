// Run: node --test custom/grocy/tests/
// Every WP4 shopping part parses, and every string it shows has English and French with no dash characters.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DIR = path.join(__dirname, "..", "companion");
const PARTS = ["shopping-merge", "shopping-theme", "shopping-beyond-rules", "shopping-i18n", "shopping-inbox-rules", "shopping-inbox", "shopping-inbox-review",
	"shopping-settings", "shopping-lists-edit", "shopping-organize", "shopping-tray", "shopping-trip", "shopping-putaway", "shopping-recipe-list",
	"shopping", "shopping-lib", "shopping-add", "shopping-edit", "shopping-lists", "stock"].map((p) => p + ".js.html");
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");
const scripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

function dictionary() {
	const d = {};
	for (const f of ["i18n.js.html", "agenda-i18n.js.html", "shopping-i18n.js.html"]) {
		const html = read(f);
		for (const m of html.matchAll(/GL\.add\((\{[\s\S]*?\})\);/g)) Object.assign(d, new Function("return " + m[1])());
		const core = /var D = (\{[\s\S]*?\n\t\});/.exec(html);
		if (core) Object.assign(d, new Function("return " + core[1])());
	}
	return d;
}

test("every WP4 part parses", () => {
	for (const f of PARTS) for (const s of scripts(read(f))) assert.doesNotThrow(() => new vm.Script(s), f);
});

test("every WP4 string has English and French, and no dash", () => {
	const d = dictionary(), used = new Set();
	for (const f of PARTS) {
		const html = read(f);
		for (const m of html.matchAll(/"((?:inbox|list|ltheme|pass|org|tray|sest|put|trip|rtl|shop\.dup|shop\.share)\.[a-zA-Z.]+)"/g)) if (!m[1].endsWith(".")) used.add(m[1]);
	}
	["grocy", "Aqua", "Purple", "Blue", "Green", "Yellow", "Orange", "Red", "Pink", "Grey"].forEach((n) => used.add("ltheme." + n));
	["banner", "text"].forEach((n) => used.add("ltheme.problem." + n));
	["receipt", "row", "store", "none"].forEach((n) => used.add("put.src." + n));
	["danger", "avoid"].forEach((n) => used.add("tray.diet." + n));
	for (const k of used) {
		assert.ok(d[k], "missing " + k);
		assert.equal(d[k].length, 2, k);
		assert.ok(d[k][0] && d[k][1], k + " empty");
	}
	for (const f of PARTS.concat(["shopping-extras.css.html"])) assert.ok(!/[\u2013\u2014]/.test(read(f)), f + " has a dash character");
});
