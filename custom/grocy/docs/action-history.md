# Shared assistant history (gc_actions)

One history for the phone app and the web: every action the assistant writes to Grocy is also one row of the
userentity `gc_actions`. Both clients list the same rows, and either one can undo, redo or duplicate a row the
other wrote, as long as the row carries what that needs.

Schema: `custom/grocy/tools/grocy-schema-actions.sh` (creates the userentity and its userfields; the grocy-test
reset applies it on its own). Web side: `companion/assistant-history.js.html` (store), `companion/assistant-rules.js.html`
(format, menu), `companion/assistant-activity.js.html` (Activity page at `/userobjects/gc_actions`).

## Storage

One Grocy userobject per action (`POST /objects/userobjects {"userentity_id": <id of gc_actions>}`), then its
fields with `PUT /userfields/userentity-gc_actions/<object id>`. A PUT with some fields keeps the others, so a
status change sends only `status` and `record`. Look the userentity id up by name, never hardcode it.

| Field | Grocy type | Content |
|---|---|---|
| `action_id` | text-single-line | UUID of the action, the app's `AssistantActionRecord.id` (uppercase or lowercase, compare case-insensitively) |
| `created` | text-single-line | ISO 8601 with offset, milliseconds allowed: `2026-10-01T21:26:32.284+02:00`. Order by instant, never as text |
| `kind` | text-single-line | `AssistantActionKind` raw value: `stockAdd`, `consume`, `spoil`, `open`, `transfer`, `inventory`, `stockEdit`, `listAdd`, `listDone`, `taskComplete`, `choreDone`, ... |
| `status` | preset-list | `AssistantActionStatus` raw value: `applied`, `failed`, `undone`, `undoFailed`, `edited`, `superseded` |
| `origin` | preset-list | `ios` or `web`: the device that wrote the action |
| `source` | text-single-line | `ActionSource` raw value: `voice`, `typed`, `redo`, `duplicate`, `edit`, `activity`, ... |
| `session_id` | text-single-line | UUID of the assistant session (`AssistantSessionRecord.id` on the phone, one panel session on the web) |
| `parent_id` | text-single-line | `action_id` this one comes from (redo, duplicate, edit), empty otherwise |
| `summary` | text-single-line | What happened, in the language of the writer at write time ("Added 2 Yaourt nature") |
| `sentence` | text-single-line | What she said or typed |
| `record` | text-multi-line | JSON document, below |

## The record document

```json
{
  "v": 1,
  "op": { "op": "add", "product_id": 10, "amount": 2, "location_id": 2, "best_before": null, "...": "the intake operation as the kitchen_intake schema returns it" },
  "product_id": 10,
  "product_name": "Yaourt nature",
  "object_type": "stockEntry",
  "object_id": null,
  "list_id": 1,
  "transaction_ids": ["6abeb23bebb75"],
  "undo": [
    { "method": "POST", "path": "stock/transactions/6abeb23bebb75/undo" }
  ],
  "undone_at": "2026-10-01T21:30:02.120+02:00",
  "undone_by": "web",
  "error": null
}
```

- `v`: format version, 1.
- `op`: the operation from the shared intake contract (`custom/n8n/src/assistant/contract.json`, same schema as the
  app's `IntakeSchema`). Redo and Duplicate replay it. Optional: without it the row has no Redo or Duplicate.
- `object_type`: `stockEntry`, `product`, `listItem`, `task`, `chore`, `recipe`, `mealPlan`, `productGroup`
  (the app's `ActionObjectType`, plus `chore`). With `object_id` and `product_id` / `list_id` it gives the Open link
  (the app's `GrocyLink.path`). `link` (a Grocy path such as `/stockentries?product=10`) overrides it when present.
- `undo`: the Grocy API calls that undo the action, run in order, each `{ method, path, body? }` with `path`
  relative to `/api/`. Allowed methods GET, POST, PUT, DELETE; allowed path roots `stock/`, `objects/`,
  `userfields/`, `tasks/`, `chores/`, `batteries/`, `recipes/`, `user/`. Empty or missing means "no undo on the
  other device": the row shows Inspect and Open only there, and the writer undoes it.
- `undone_at`, `undone_by` (`ios` or `web`), `error`: set when a client undoes the row or an undo fails.
- Any other key is free for the writer (the web adds `amount`, `best_before`, `amount_before`, `product_created`,
  `chore_log_id`, `before`). Readers ignore keys they do not know.

Undo calls the web writes today:

| Action | Undo |
|---|---|
| Stock add, consume, spoil, open, move, count | `POST stock/transactions/<id>/undo` per transaction, newest first; a product created for the add then `DELETE objects/products/<id>` |
| New best before on a batch | `PUT stock/entry/<id>` with the batch as it was |
| On the list (new row) | `DELETE objects/shopping_list/<row>` |
| On the list (row already there) | `PUT objects/shopping_list/<row> {"amount": <before>}` or the uncross calls |
| Tick, untick | `PUT objects/shopping_list/<row> {"done": 0 or 1}` and `PUT userfields/shopping_list/<row> {"al_crossed_at": ...}` |
| Off the list | `POST objects/shopping_list` with the row's fields |
| New task | `DELETE objects/tasks/<id>` |
| Task done, not done | `POST tasks/<id>/undo`, `POST tasks/<id>/complete` |
| Chore done | `POST chores/executions/<log id>/undo` |

## Menu rules (both clients)

The menu of a row is the app's `ActionMenuModel.items` read from the shared fields:

- Inspect: always.
- Undo: `status` is `applied` or `edited` and `record.undo` is not empty. Running it sets `status` to `undone`
  (or `undoFailed` with `record.error`).
- Redo: `status` is `undone` and `record.op` is an operation the client can apply. It writes a new row with
  `source` `redo` and `parent_id` the first row; the first row stays `undone`.
- Duplicate: `status` is `applied` or `edited` and `record.op` can be applied. New row, `source` `duplicate`.
- Undo from here: Undo is possible and the same `session_id` has more undoable rows at or after this one (by
  instant). Undoes them newest first and stops at the first failure.
- Open: a link can be built from `record`.

## What the iOS app must add

1. On every `ActionLog.record` of a Grocy write: POST the userobject and PUT the fields above, `origin` `ios`,
   `record.op` from the intake operation, `record.undo` from its compensation (the Grocy calls `Compensation*` and
   `ActionLog+Undo*` already make). Queue the write when offline, like other Grocy writes.
2. On every status change (undo, undo failed, edit, superseded): PUT `status` and `record` of its row (find it by
   `action_id`).
3. Activity: merge rows with `origin` `web` into the list (read `gc_actions`, order by `created` as an instant),
   with the menu above; Undo of a web row runs its `record.undo` calls through `AssistantGrocyClient`, then PUTs the
   status.
4. On refresh, read the status of its own rows back from Grocy so an undo done on the web shows as undone.
5. Use the shared contract: `custom/n8n/src/assistant/contract.json` is exported from the app's `IntakeSchema`,
   `IntakePrompt` (+Stock, +Areas, +Chores, +List) and `AssistantSettings` by
   `custom/n8n/src/assistant/export-contract.mjs`; the n8n test fails when the two drift. Loading that file as a
   bundle resource instead of the Swift string literals makes it one file for both.
