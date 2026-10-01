// Run: node --test custom/grocy/tests/
// Same fixtures and expectations as the app's AgendaSectionsTests, ThingsListsTests and AgendaFilterTests.
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
const A = load("agenda-rules.js.html");
const F = load("agenda-filter.js.html");
const S = load("agenda-calendar.js.html");

const NOW = "2026-09-27 14:00:00"; // Sunday, Paris wall time
const now = A.wall(NOW);
const keys = (list) => list.map((e) => e.key);

function data() {
	return {
		chores: [
			{ id: 1, name: "Clean the sink", active: 1, period_type: "daily", period_interval: 1, start_date: "2026-09-01 09:00:00", rollover: 0, userfields: { room: "kitchen", effort: "2" } },
			{ id: 2, name: "Take out the recycling", active: 1, period_type: "weekly", period_interval: 1, period_config: "sunday", rollover: 0, userfields: { room: "kitchen" } },
			{ id: 3, name: "Water the plants", active: 1, period_type: "daily", period_interval: 3, rollover: 0, userfields: { room: "living_room", effort: "1" } },
			{ id: 4, name: "Scrub the shower", active: 1, period_type: "weekly", period_interval: 1, period_config: "saturday", track_date_only: 1, rollover: 0, userfields: { room: "bathroom" } },
			{ id: 5, name: "Rolling chore", active: 1, period_type: "daily", period_interval: 2, rollover: 1, userfields: {} },
			{ id: 6, name: "Paused chore", active: 0, period_type: "daily", period_interval: 1, rollover: 0, userfields: {} },
			{ id: 7, name: "Sweep the porch", active: 1, period_type: "monthly", period_interval: 1, period_days: 3, rollover: 0, userfields: { tags: "outside, quick" } }
		],
		current: [
			{ chore_id: 1, next_estimated_execution_time: "2026-09-25 09:00:00", last_tracked_time: "2026-09-24 09:00:00", track_date_only: 0 },
			{ chore_id: 2, next_estimated_execution_time: "2026-09-27 19:00:00", last_tracked_time: "2026-09-20 19:00:00", track_date_only: 0 },
			{ chore_id: 3, next_estimated_execution_time: "2026-09-28 08:00:00", last_tracked_time: "2026-09-25 08:00:00", track_date_only: 0 },
			{ chore_id: 4, next_estimated_execution_time: "2026-10-03 23:59:59", last_tracked_time: "2026-09-26 10:00:00", track_date_only: 1 },
			{ chore_id: 5, next_estimated_execution_time: "2026-09-26 08:00:00", last_tracked_time: "2026-09-24 08:00:00", track_date_only: 0 },
			{ chore_id: 7, next_estimated_execution_time: "2026-11-03 00:00:00", last_tracked_time: null, track_date_only: 0 }
		],
		log: [{ id: 1, chore_id: 3, skipped: 1, undone: 0 }, { id: 2, chore_id: 3, skipped: 1, undone: 0 }, { id: 3, chore_id: 3, skipped: 1, undone: 1 }],
		tasks: [
			{ id: 10, name: "Pay the electricity bill", done: 0, due_date: "2026-09-26", category_id: 1, userfields: { priority: "high" } },
			{ id: 11, name: "Call the bank", done: 0, due_date: "2026-09-27 18:30:00", category_id: 1, userfields: {} },
			{ id: 12, name: "Plan the weekend menu", done: 0, due_date: null, userfields: { planned: "2026-09-27", steps: "- [x] list\n- [ ] shop\n- [ ] cook" } },
			{ id: 13, name: "Book the plumber", done: 0, due_date: "2026-09-28", userfields: { room: "bathroom", priority: "urgent" } },
			{ id: 14, name: "Sort the papers", done: 0, due_date: null, userfields: {} },
			{ id: 15, name: "Done already", done: 1, due_date: "2026-09-27", userfields: {} },
			{ id: 16, name: "Call mom at 10", done: 0, due_date: "2026-09-27 10:00:00", userfields: {} }
		],
		categories: [{ id: 1, name: "Admin" }],
		batteries: [{ battery_id: 20, last_tracked_time: "2026-09-01 10:00:00", next_estimated_charge_time: "2026-10-01 10:00:00", battery: { id: 20, name: "Smoke alarm", active: 1, used_in: "Hall" } },
			{ battery_id: 21, last_tracked_time: null, next_estimated_charge_time: "2999-12-31 23:59:59", battery: { id: 21, name: "Remote", active: 1 } }]
	};
}
const entries = () => A.entries(data(), NOW);

test("entries come from chores, open tasks and batteries; paused chores stay out", () => {
	const list = entries();
	assert.ok(!list.some((e) => e.key === "chore:6" || e.key === "task:15"));
	assert.equal(list.length, 6 + 6 + 2);
	const plan = list.find((e) => e.key === "task:12");
	assert.deepEqual([plan.stepsDone, plan.stepsTotal, A.dayText(plan.due), plan.hasTime], [1, 3, "2026-09-27", false]);
	assert.equal(list.find((e) => e.key === "chore:3").skippedCount, 2);
	assert.equal(list.find((e) => e.key === "battery:21").due, null);
	assert.deepEqual(list.find((e) => e.key === "chore:7").tags, ["outside", "quick"]);
});

test("This evening holds timed things due today from 17:00", () => {
	const t = A.today(entries(), now);
	assert.deepEqual(keys(t.evening), ["task:11", "chore:2"]);
	assert.ok(!t.evening.some((e) => e.key === "task:12"), "a planned day without time stays in Today");
});

test("Today puts overdue first, rolls a rolling chore into today, a planned day never goes overdue", () => {
	const t = A.today(entries(), now);
	assert.deepEqual(keys(t.now), ["chore:1", "task:10", "task:16", "chore:5", "task:12"]);
	const s = A.build(entries(), now);
	assert.deepEqual(s.map((x) => x.kind), ["overdue", "today", "evening", "tomorrow", "week", "later", "noDate"]);
	assert.equal(A.section(entries().find((e) => e.key === "chore:5"), now), "today");
	assert.equal(A.daysLate(entries().find((e) => e.key === "chore:1"), now), 2);
	assert.equal(A.daysLate(entries().find((e) => e.key === "task:16"), now), 0, "a time earlier today is overdue but 0 days late");
});

test("undated batteries only show when asked", () => {
	assert.ok(!A.build(entries(), now).some((s) => s.entries.some((e) => e.key === "battery:21")));
	assert.equal(A.section(entries().find((e) => e.key === "battery:21"), now, true), "noDate");
});

test("Upcoming groups one heading per day for 7 days, then per month", () => {
	const g = A.upcoming(entries(), now);
	assert.deepEqual(g.map((x) => [x.span, A.dayText(x.date)]), [["day", "2026-09-28"], ["day", "2026-10-01"], ["day", "2026-10-03"], ["month", "2026-11-01"]]);
	assert.deepEqual(keys(g[0].entries), ["task:13", "chore:3"]);
	assert.deepEqual(keys(g[3].entries), ["chore:7"]);
});

test("Anytime is everything not waiting for a later day, by room, category, then none", () => {
	const a = A.anytime(entries(), now);
	assert.deepEqual(a.map((x) => x.area.type + ":" + x.area.key), ["room:kitchen", "category:Admin", "none:"]);
	assert.deepEqual(keys(a[0].entries), ["chore:1", "chore:2"]);
	assert.ok(a[2].entries.some((e) => e.key === "task:14") && !a[2].entries.some((e) => e.key === "battery:21"), "undated batteries stay out, like the app");
});

test("dueness buckets and rooms overview", () => {
	assert.deepEqual([0.2, 0.7, 1, 1.2, 1.3].map(A.bucket), ["fresh", "soon", "due", "due", "late"]);
	const o = A.rooms(entries());
	assert.deepEqual(o.tiles.map((t) => t.room), ["kitchen", "bathroom", "bedroom", "living_room", null]);
	assert.equal(o.tiles[0].bucket, "late");
	assert.equal(o.tiles[2].chores.length + o.tiles[2].tasks.length, 0);
	assert.ok(o.freshness >= 0 && o.freshness <= 1);
});

test("logbook merges tasks, chores and batteries newest first by day, undone rows left out", () => {
	const days = A.logbook({ tasks: [{ id: 1, name: "T", done: 1, done_timestamp: "2026-09-27 09:00:00" }],
		log: [{ id: 5, chore_id: 1, tracked_time: "2026-09-27 11:00:00", skipped: 0, undone: 0 }, { id: 6, chore_id: 1, tracked_time: "2026-09-26 11:00:00", skipped: 1, undone: 0 },
			{ id: 7, chore_id: 1, tracked_time: "2026-09-26 12:00:00", undone: 1 }],
		cycles: [{ id: 9, battery_id: 2, tracked_time: "2026-09-25 08:00:00", undone: 0 }], chores: [{ id: 1, name: "C" }], batteries: [{ id: 2, name: "B" }] });
	assert.deepEqual(days.map((d) => [A.dayText(d.day), d.items.map((i) => i.id)]), [["2026-09-27", ["chore:5", "task:1"]], ["2026-09-26", ["chore:6"]], ["2026-09-25", ["battery:9"]]]);
	assert.equal(days[1].items[0].skipped, true);
});

test("postpone quick picks follow the app", () => {
	const p = A.postponePicks(now);
	assert.deepEqual(p.map((x) => [x.key, A.fmt(x.at)]), [["laterToday", "2026-09-27 17:00:00"], ["tomorrow", "2026-09-28 14:00:00"],
		["weekend", "2026-10-03 10:00:00"], ["nextWeek", "2026-09-28 14:00:00"]]);
	assert.ok(!A.postponePicks(A.wall("2026-09-27 21:30:00")).some((x) => x.key === "laterToday"));
	assert.equal(A.fmt(A.postponePicks(A.wall("2026-10-03 09:00:00"))[2].at), "2026-10-04 10:00:00");
});

test("filters: words, rooms in EN or FR, priority, sections, negation and or", () => {
	const list = entries();
	const hit = (q) => keys(list.filter((e) => F.matches(F.parse(q), e, now, A))).sort();
	assert.deepEqual(hit("#cuisine"), ["chore:1", "chore:2"]);
	assert.deepEqual(hit("#salle"), ["chore:4", "task:13"]);
	assert.deepEqual(hit("!1"), ["task:13"]);
	assert.deepEqual(hit("@adm -today"), ["task:10"]);
	assert.deepEqual(hit("tag:out | skipped>1"), ["chore:3", "chore:7"]);
	assert.deepEqual(hit("type:battery"), ["battery:20", "battery:21"]);
	assert.deepEqual(hit("plumb"), ["task:13"]);
	assert.deepEqual(hit("late>1"), ["chore:1"]);
	assert.deepEqual(F.validate("#").error, "unknownToken");
	assert.deepEqual(F.validate("  ").error, "empty");
	assert.ok(F.validate("today #kitchen").ok);
	const saved = F.addSaved([], "Kitchen", "#kitchen", "A").ok;
	assert.deepEqual(saved, [{ id: "A", name: "Kitchen", query: "#kitchen", pinned: true, order: 0 }]);
	assert.equal(F.addSaved(saved, "kitchen", "#cuisine today", "B").ok.length, 1, "same name replaces");
	assert.equal(F.addSaved(saved, "", "#x").error, "noName");
});

test("calendar: next dates by the rule and a Monday first month grid", () => {
	const fmt = (l) => l.map(A.fmt);
	assert.deepEqual(fmt(S.nextDates({ period_type: "daily", period_interval: 2, start_date: "2026-09-01 08:00:00" }, "2026-09-26 19:00:00", 3)),
		["2026-09-28 08:00:00", "2026-09-30 08:00:00", "2026-10-02 08:00:00"]);
	assert.deepEqual(fmt(S.nextDates({ period_type: "weekly", period_interval: 1, period_config: "monday,thursday", start_date: "2026-09-01 10:00:00" }, "2026-09-28 10:00:00", 3)),
		["2026-10-01 10:00:00", "2026-10-05 10:00:00", "2026-10-08 10:00:00"]);
	assert.deepEqual(fmt(S.nextDates({ period_type: "monthly", period_interval: 1, period_days: 5, start_date: "2026-09-01", track_date_only: 1 }, "2026-09-05", 2)),
		["2026-10-05 23:59:59", "2026-11-05 23:59:59"]);
	assert.deepEqual(fmt(S.nextDates({ period_type: "weekly", period_config: "friday", rescheduled_date: "2026-09-30 09:00:00", start_date: "2026-09-01 09:00:00" }, "2026-09-25 09:00:00", 2)),
		["2026-09-30 09:00:00", "2026-10-02 09:00:00"]);
	assert.deepEqual(S.nextDates({ period_type: "manually", start_date: "2026-09-01" }, null, 3), []);
	const g = S.monthGrid(2026, 8);
	assert.equal(g[0].filter((x) => x === null).length, 1, "1 September 2026 is a Tuesday");
	assert.ok(g.every((w) => w.length === 7));
	const map = S.dayMap({ entries: entries(), chores: data().chores, current: data().current }, now, [{ id: 1, day: "2026-09-29", recipe_id: 3 }], [{ id: 3, name: "Soup" }]);
	assert.ok(map[A.wall("2026-09-29")].some((i) => i.kind === "meal" && i.name === "Soup"));
	assert.ok(map[A.wall("2026-09-26")].some((i) => i.key === "chore:1" && i.projected), "daily chore projected the day after its due day");
});
