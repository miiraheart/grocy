// Run: node --test custom/grocy/tests/
// The same quickadd-cases.json runs in the app (QuickAddCasesFixtureTests), so web and app parse alike.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function load(file) {
	const html = fs.readFileSync(path.join(__dirname, "..", "companion", file), "utf8");
	const module = { exports: {} };
	new Function("module", html.replace(/^[\s\S]*?<script>/, "").replace(/<\/script>[\s\S]*$/, ""))(module);
	return module.exports;
}
const Q = load("agenda-quickadd.js.html");
const doc = JSON.parse(fs.readFileSync(path.join(__dirname, "quickadd-cases.json"), "utf8"));

function scheduleOf(s) {
	if (!s) return null;
	const n = Q.schedule(s.period, s.interval, s.weekdays, s.dayOfMonth, s.startDate);
	return { fields: Q.scheduleFields(n), startDate: n.startDate };
}

for (const c of doc.cases) {
	test("case: " + c.text, () => {
		const r = Q.parse(c.text, { now: doc.now, categories: c.categories || [] });
		for (const [key, want] of Object.entries(c.expect)) {
			if (key === "schedule") {
				const expected = want ? Object.assign({ startDate: null }, scheduleOf(want)) : null;
				assert.deepEqual(r.schedule ? scheduleOf(r.schedule) : null, expected, "schedule");
			} else {
				assert.deepEqual(r[key], want, key);
			}
		}
		if (c.expect.handOff === true) assert.equal(r.canSave, false);
		if (c.expect.schedule) assert.ok(r.isChore && r.canSave);
		if (c.expect.schedule === null && c.expect.handOff === false) assert.ok(!r.isChore && r.canSave);
	});
}

test("the case file covers every phrase family in EN and FR", () => {
	assert.ok(doc.cases.length >= 60);
	assert.ok(doc.cases.some((c) => /tous les/.test(c.text)) && doc.cases.some((c) => /every/.test(c.text)));
});

test("columns follow the app drafts", () => {
	const task = Q.parse("Call the bank tomorrow 18:30 #admin !2", { now: doc.now, categories: ["Admin"] });
	assert.deepEqual(Q.taskColumns(task, 4), { name: "Call the bank", description: null, due_date: "2026-09-28 18:30:00", category_id: 4 });
	assert.deepEqual(Q.extras(task), { priority: "high" });
	const chore = Q.parse("Vacuum every 3 days #salon ~2", { now: doc.now });
	assert.deepEqual(Q.choreColumns(chore, doc.now, true), { period_type: "daily", period_interval: 3, period_config: "", period_days: 1,
		name: "Vacuum", description: null, start_date: "2026-09-27 14:00:00", rollover: 1 });
	assert.deepEqual(Q.extras(chore), { room: "living_room", effort: "2" });
	const weekly = Q.parse("Gym every monday and thursday", { now: doc.now });
	assert.equal(Q.choreColumns(weekly, doc.now).period_config, "monday,thursday");
	assert.equal(Q.choreColumns(Q.parse("Medicine every 6 hours", { now: doc.now }), doc.now).period_days, undefined);
});

test("a hand-off is cut into the things it lists", () => {
	assert.deepEqual(Q.splitParts("Buy milk, eggs and call mom"), ["Buy milk", "eggs", "call mom"]);
	assert.deepEqual(Q.splitParts("Acheter du lait et appeler maman demain"), ["Acheter du lait", "appeler maman demain"]);
});
