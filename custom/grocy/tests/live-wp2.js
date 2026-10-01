// Live check of the WP2 Agenda page against grocy-test only, through the same API calls companion/agenda-data.js.html makes.
// Run: node custom/grocy/tests/live-wp2.js   (the API key is read here from ~/.config/grocy/credentials)
// Every object it creates is named "ZZ wp2 ..."; every write is undone and every object deleted; before and after counts must match.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const BASE = "https://grocy-test.audibox.cc/api";
if (new URL(BASE).hostname !== "grocy-test.audibox.cc") throw new Error("grocy-test only");
const creds = fs.readFileSync(path.join(os.homedir(), ".config/grocy/credentials"), "utf8");
const KEY = (/^GROCY_API_KEY=(.*)$/m.exec(creds) || [])[1].replace(/["'\s]/g, "");

function load(file) {
	const html = fs.readFileSync(path.join(__dirname, "..", "companion", file), "utf8");
	const module = { exports: {} };
	new Function("module", html.replace(/^[\s\S]*?<script>/, "").replace(/<\/script>[\s\S]*$/, ""))(module);
	return module.exports;
}
const A = load("agenda-rules.js.html"), Q = load("agenda-quickadd.js.html"), F = load("agenda-filter.js.html");

async function api(method, p, body) {
	const r = await fetch(BASE + "/" + p, { method, headers: { "GROCY-API-KEY": KEY, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const t = await r.text();
	const j = t ? JSON.parse(t) : null;
	if (!r.ok) throw new Error(method + " " + p + ": " + ((j && j.error_message) || r.status));
	return j;
}
const ok = (msg) => console.log("ok  " + msg);
const parisNow = () => new Date().toLocaleString("sv-SE", { timeZone: "Europe/Paris" }).replace("T", " ");
const made = { chores: [], tasks: [], batteries: [], categories: [] };

async function snapshot() {
	const [c, t, b, k, s] = await Promise.all(["objects/chores", "objects/tasks", "objects/batteries", "objects/task_categories", "user/settings/gc_chore_filters"]
		.map((p) => api("GET", p).catch(() => null)));
	return { chores: c.length, tasks: t.length, batteries: b.length, categories: k.length, filters: s && s.value };
}

async function loadAll() {
	const r = await Promise.all(["objects/chores", "chores", "objects/chores_log", "objects/tasks?query[]=done=0", "objects/task_categories", "batteries"].map((p) => api("GET", p)));
	const d = { chores: r[0], current: r[1], log: r[2], tasks: r[3], categories: r[4], batteries: r[5] };
	return { d, now: A.wall(parisNow()), entries: A.entries(d, parisNow()) };
}

async function create(line) {
	const cats = await api("GET", "objects/task_categories");
	const r = Q.parse(line, { now: parisNow(), categories: cats.map((c) => c.name) });
	assert.ok(r.canSave, "saveable: " + line);
	const extras = Q.extras(r);
	if (r.isChore) {
		const id = +(await api("POST", "objects/chores", Q.choreColumns(r, parisNow(), true))).created_object_id;
		made.chores.push(id);
		if (Object.keys(extras).length) await api("PUT", "userfields/chores/" + id, extras);
		return { kind: "chore", id, r };
	}
	let categoryId = null;
	if (r.category) {
		const known = cats.find((c) => Q.fold(c.name) === Q.fold(r.category));
		categoryId = known ? known.id : +(await api("POST", "objects/task_categories", { name: r.category })).created_object_id;
		if (!known) made.categories.push(categoryId);
	}
	const id = +(await api("POST", "objects/tasks", Q.taskColumns(r, categoryId))).created_object_id;
	made.tasks.push(id);
	if (Object.keys(extras).length) await api("PUT", "userfields/tasks/" + id, extras);
	return { kind: "task", id, r };
}

async function main() {
	const before = await snapshot();
	const vac = await create("ZZ wp2 Vacuum every 3 days #salon ~2");
	const chore = await api("GET", "objects/chores/" + vac.id);
	assert.deepEqual([chore.period_type, +chore.period_interval, String(chore.rollover), chore.userfields.room, chore.userfields.effort], ["daily", 3, "1", "living_room", "2"]);
	ok("quick add chore: daily every 3, rollover on, room living_room, effort 2");

	const bank = await create("ZZ wp2 Call the bank tomorrow 18:30 !2 #zzwp2admin");
	const task = await api("GET", "objects/tasks/" + bank.id);
	assert.equal(task.due_date, bank.r.day + " 18:30:00");
	assert.equal(task.userfields.priority, "high");
	ok("quick add task: due " + task.due_date + ", priority high, new category created");

	const evening = await create("ZZ wp2 Bins tonight");
	let L = await loadAll();
	const ev = L.entries.find((e) => e.key === "task:" + evening.id);
	const sectionOf = A.section(ev, L.now);
	assert.equal(sectionOf, A.wall(parisNow()) < A.wall(evening.r.day + " 19:00:00") ? "evening" : "overdue");
	assert.equal(A.section(L.entries.find((e) => e.key === "task:" + bank.id), L.now), "tomorrow");
	assert.ok(A.upcoming(L.entries, L.now).some((g) => g.entries.some((e) => e.key === "task:" + bank.id)));
	assert.ok(A.anytime(L.entries, L.now).some((g) => g.area.key === "living_room" && g.entries.some((e) => e.key === "chore:" + vac.id)));
	ok("live lists: tonight in " + sectionOf + ", tomorrow in Upcoming, the new chore under Living room in Anytime");

	const exec = await api("POST", "chores/" + vac.id + "/execute", {});
	assert.ok((await api("GET", "chores/" + vac.id)).tracked_count === 1);
	await api("POST", "chores/executions/" + exec.id + "/undo");
	assert.equal((await api("GET", "chores/" + vac.id)).tracked_count, 0);
	const skip = await api("POST", "chores/" + vac.id + "/execute", { skipped: true });
	assert.equal(String(skip.skipped), "1");
	await api("POST", "chores/executions/" + skip.id + "/undo");
	ok("chore done and skip, both undone (tracked count back to 0)");

	await api("POST", "tasks/" + bank.id + "/complete", {});
	const lb = A.logbook({ tasks: await api("GET", "objects/tasks?query[]=done=1"), log: [], cycles: [], chores: [], batteries: [] });
	assert.ok(lb[0].items.some((i) => i.id === "task:" + bank.id));
	await api("POST", "tasks/" + bank.id + "/undo");
	assert.equal(String((await api("GET", "objects/tasks/" + bank.id)).done), "0");
	ok("task done shows in the logbook, undone");

	const pick = A.postponePicks(A.wall(parisNow())).find((p) => p.key === "nextWeek");
	await api("PUT", "objects/tasks/" + bank.id, { due_date: A.dayText(pick.at) + " 18:30:00" });
	assert.equal((await api("GET", "objects/tasks/" + bank.id)).due_date, A.dayText(pick.at) + " 18:30:00");
	await api("PUT", "objects/tasks/" + bank.id, { due_date: task.due_date });
	await api("PUT", "objects/chores/" + vac.id, { rescheduled_date: A.fmt(pick.at) });
	const moved = (await api("GET", "chores")).find((c) => c.chore_id === vac.id);
	assert.equal(moved.next_estimated_execution_time, A.fmt(pick.at));
	await api("PUT", "objects/chores/" + vac.id, { rescheduled_date: null });
	assert.equal((await api("GET", "objects/chores/" + vac.id)).rescheduled_date, null);
	ok("postpone next week: task due day and chore rescheduled_date written and put back");

	await api("PUT", "objects/chores/" + vac.id, { active: 0 });
	L = await loadAll();
	assert.ok(!L.entries.some((e) => e.key === "chore:" + vac.id) && L.d.chores.some((c) => c.id === vac.id && String(c.active) === "0"));
	await api("PUT", "objects/chores/" + vac.id, { active: 1 });
	ok("pause moves the chore to Someday, resume brings it back");

	const bat = +(await api("POST", "objects/batteries", { name: "ZZ wp2 Smoke alarm", charge_interval_days: 30 })).created_object_id;
	made.batteries.push(bat);
	const cycle = await api("POST", "batteries/" + bat + "/charge", {});
	L = await loadAll();
	const be = L.entries.find((e) => e.key === "battery:" + bat);
	assert.equal(A.days(L.now, be.due), 30);
	await api("POST", "batteries/charge-cycles/" + cycle.id + "/undo");
	ok("battery changed then undone; next change 30 days out");

	const filters = F.addSaved([], "ZZ wp2 living", "#salon", "ZZ-WP2").ok;
	await api("PUT", "user/settings/gc_chore_filters", { value: JSON.stringify(filters) });
	const back = F.sortSaved(JSON.parse((await api("GET", "user/settings/gc_chore_filters")).value));
	L = await loadAll();
	const hits = L.entries.filter((e) => F.matches(F.parse(back[0].query), e, L.now, A)).map((e) => e.key);
	assert.ok(hits.includes("chore:" + vac.id));
	if (before.filters != null) await api("PUT", "user/settings/gc_chore_filters", { value: before.filters });
	else await api("DELETE", "user/settings/gc_chore_filters");
	ok("saved filter round trip in the user setting, restored");

	await cleanup();
	const after = await snapshot();
	assert.deepEqual(after, before);
	ok("after equals before " + JSON.stringify(after));
}

async function cleanup() {
	for (const id of made.chores) {
		await api("PUT", "userfields/chores/" + id, { room: "", effort: "" }).catch(() => {});
		await api("DELETE", "objects/chores/" + id).catch((e) => console.log("cleanup " + e.message));
	}
	for (const id of made.tasks) {
		await api("PUT", "userfields/tasks/" + id, { priority: "" }).catch(() => {});
		await api("DELETE", "objects/tasks/" + id).catch((e) => console.log("cleanup " + e.message));
	}
	for (const id of made.batteries) await api("DELETE", "objects/batteries/" + id).catch((e) => console.log("cleanup " + e.message));
	for (const id of made.categories) await api("DELETE", "objects/task_categories/" + id).catch((e) => console.log("cleanup " + e.message));
	made.chores = []; made.tasks = []; made.batteries = []; made.categories = [];
}

main().catch(async (e) => { console.log("FAIL " + e.stack); await cleanup(); process.exit(1); });
