// WP5 live check on grocy-test: the web assistant in the browser, its model call answered by the assistant-intake
// TEST twin run on this Mac (free model, OpenRouter test key), cards applied to Grocy, the shared history, spoken undo,
// an answer, the screen product, then the Activity page menu (live-wp5-activity.js). Every write is undone.
// Run: NODE_PATH=<dir with playwright-core> PW_CHROMIUM=<headless shell> node live-wp5.js [shots dir]
const assert = require("node:assert/strict");
const path = require("node:path");
const L = require("./live-wp5-lib.js");
const { api, ok } = L;
const SHOTS = process.argv[2] || "";

(async () => {
	const before = await L.snapshot();
	const made = { chores: [], tasks: [] };
	const chore = (await api("POST", "objects/chores", { name: "ZZ wp5 aspirateur", period_type: "manually" })).created_object_id;
	made.chores.push(chore);
	const task = (await api("POST", "objects/tasks", { name: "ZZ wp5 appeler la banque" })).created_object_id;
	made.tasks.push(task);
	const localeBefore = await L.setting("locale");
	const { b, page, errors } = await L.browser();
	await L.twinRoute(page);
	try {
		// FR: three things in one sentence on the Riz basmati page; cards first, nothing written before Apply all.
		await L.setting("locale", "fr");
		await L.openPanel(page, "/stockentries?product=22");
		await L.newSession(page);
		const rows1 = await L.say(page, "J'ai acheté 2 beurres moulés, mets-les au frigo. Il n'y a plus de riz basmati et j'ai passé l'aspirateur ZZ wp5.");
		const add = rows1.find((r) => r.op.op === "add"), outOf = rows1.find((r) => r.op.op === "out_of"), done = rows1.find((r) => r.op.op === "chore_done");
		assert.ok(add && add.op.product_id === 7 && add.op.amount === 2 && add.op.location_id === 2, "add 2 Beurre moulé to the fridge: " + JSON.stringify(rows1.map((r) => r.op)));
		assert.ok(outOf && outOf.op.product_id === 22, "riz basmati to the list");
		assert.ok(done && done.op.target_id === +chore, "the ZZ chore done");
		assert.equal(await L.stockOf(7), before.stock[7], "nothing written before confirming");
		ok("FR sentence gives 3 draft cards (add 2 Beurre moulé fridge, riz on the list, chore done); nothing written yet");
		if (SHOTS) await L.shots(page, "web-assistant-cards", () => L.openPanel(page, "/stockentries?product=22"), SHOTS);

		await L.setting("locale", "fr");
		await L.openPanel(page, "/stockentries?product=22");
		await page.click(".gc-as-all");
		await page.waitForFunction(() => Object.values(GC.assist.session.state.rows).every((r) => r.status !== "draft" && r.status !== "working"), null, { timeout: 30000 });
		const applied = await L.rows(page);
		assert.ok(applied.filter((r) => ["add", "out_of", "chore_done"].includes(r.op.op)).every((r) => r.status === "applied"), JSON.stringify(applied.map((r) => [r.op.op, r.status, r.error])));
		assert.equal(await L.stockOf(7), before.stock[7] + 2);
		const riz = (await L.listRows(1)).find((r) => +r.product_id === 22);
		assert.equal(+riz.amount, before.riz + 1);
		const log = await api("GET", "objects/chores_log?query[]=chore_id=" + chore);
		assert.equal(log.filter((x) => +x.undone === 0).length, 1);
		const hist = await L.history();
		assert.equal(hist.length, before.history + 3, "3 entries in the shared history");
		assert.ok(hist.every((h) => h.origin === "web" && h.record.undo && h.record.undo.length), "each entry carries its undo calls");
		ok("Apply all wrote stock +2, riz amount +1, chore log 1, and 3 gc_actions entries with undo calls");

		// Spoken undo: the chore entry comes back as an undo card; applying it undoes the execution and marks the entry undone.
		const rows2 = await L.say(page, "annule le dernier");
		const undoCard = rows2.find((r) => r.op.op === "undo");
		assert.ok(undoCard, "an undo card: " + JSON.stringify(rows2.map((r) => r.op.op)));
		await L.applyRow(page, undoCard.row_id);
		const log2 = await api("GET", "objects/chores_log?query[]=chore_id=" + chore);
		assert.equal(log2.filter((x) => +x.undone === 0).length, 0, "chore execution undone");
		assert.equal((await L.history()).find((h) => h.kind === "choreDone").status, "undone");
		ok("\"annule le dernier\" undid the chore and marked its history entry undone");

		// A question: answered from Grocy reads, nothing written.
		await L.say(page, "combien de riz basmati il me reste ?");
		const answer = await page.textContent(".gc-as-turn:last-child .gc-as-answer").catch(() => "");
		assert.ok(/riz basmati/i.test(answer), "answer: " + answer);
		ok("question answered: " + answer.replace(/\s+/g, " ").trim().slice(0, 80));

		// Screen context: on the Chicken page "j'en ai mangé un" is about Chicken.
		await L.openPanel(page, "/stockentries?product=21");
		await L.newSession(page);
		const rows3 = await L.say(page, "j'en ai mangé un");
		const eat = rows3.find((r) => r.op.op === "consume");
		assert.ok(eat && eat.op.product_id === 21, "consume the product on screen: " + JSON.stringify(rows3.map((r) => r.op)));
		await L.applyRow(page, eat.row_id);
		assert.equal(await L.stockOf(21), before.stock[21] - 1);
		ok("screen context: \"j'en ai mangé un\" on the Chicken page consumed 1 Chicken");

		// EN: a task, then the whole session undone by voice.
		await L.setting("locale", "en");
		await L.openPanel(page, "/tasks");
		await L.newSession(page);
		const rows4 = await L.say(page, "Add a task to call the plumber tomorrow, and I called the bank ZZ wp5");
		const tAdd = rows4.find((r) => r.op.op === "task_add"), tDone = rows4.find((r) => r.op.op === "task_done");
		assert.ok(tAdd && /plumber/i.test(tAdd.op.text || tAdd.op.name_spoken || ""), "task_add: " + JSON.stringify(rows4.map((r) => r.op)));
		assert.ok(tDone && tDone.op.target_id === +task, "task_done on the ZZ task");
		await L.applyAll(page);
		assert.equal(+(await api("GET", "objects/tasks/" + task)).done, 1);
		ok("EN: task added and the ZZ task done");

		await require("./live-wp5-activity.js")(page, before, SHOTS);

		const after = await L.snapshot();
		assert.deepEqual(after.stock, before.stock, "stock amounts back");
		assert.equal(after.riz, before.riz, "riz amount back on the list");
		assert.equal(after.listRows, before.listRows, "list rows back");
		assert.equal(after.tasks, before.tasks + 1, "only the ZZ setup task is left");
		assert.equal(+(await api("GET", "objects/tasks/" + task)).done, 0, "the ZZ task is open again");
		assert.equal(after.products, before.products);
		assert.deepEqual(errors, [], "no page errors");
		ok("every write undone: stock, list, tasks and products as before");
	} finally {
		await L.setting("locale", localeBefore || "en");
		await b.close();
		await L.cleanup(made, before);
	}
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
