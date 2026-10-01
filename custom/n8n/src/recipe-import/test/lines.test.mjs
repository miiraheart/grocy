import { test } from "node:test";
import assert from "node:assert/strict";
import { loadLib, source } from "./load.mjs";

const { parseLine } = loadLib(["lines-lib.js"], ["parseLine"]);
const corpus = JSON.parse(source("test/ingredient-lines.json"));
const near = (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-9);

test("the corpus has at least 150 lines", () => assert.ok(corpus.length >= 150));

for (const { raw, expect } of corpus) {
  test("line " + JSON.stringify(raw), () => {
    const got = parseLine(raw);
    assert.ok(near(got.quantity, expect.quantity), "quantity " + got.quantity);
    assert.ok(near(got.quantity_max, expect.quantity_max), "quantity_max " + got.quantity_max);
    assert.equal(got.unit, expect.unit);
    assert.equal(got.name, expect.name);
    assert.equal(got.note, expect.note);
    assert.equal(got.optional, expect.optional);
    assert.deepEqual(got.size, expect.size);
    assert.deepEqual(got.alt, expect.alt);
  });
}
