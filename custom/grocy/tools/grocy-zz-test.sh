#!/usr/bin/env bash
# Proves the cooked dish flow of 13-SCHEMA.md on the live Grocy with ZZ objects, then removes them.
# Usage on audibox: bash grocy-zz-test.sh   (exit code 0 only if every check passed and cleanup is verified)
set -euo pipefail
. "$(dirname "$0")/grocy-lib.sh"

FRIDGE=2
FREEZER=4
TODAY=$(date +%F)
PRODUCT_ID=""
STOCK_ID=""
OBJECT_ID=""
TICKET_FIELDS=(store purchased_at total currency status lines_json raw_ocr parser)

ok() { echo "OK   $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
expect() {
  if [ "$2" == "$3" ]; then ok "$1: $2"; else fail "$1: expected '$3', got '$2'"; fi
}

entry_at() {
  api GET "/objects/stock?query%5B%5D=product_id%3D$PRODUCT_ID" | jq -c --argjson l "$1" '[.[] | select(.location_id == $l)][0] // empty'
}

cleanup() {
  local status=$?
  set +e
  echo "--- cleanup"
  if [ -n "$OBJECT_ID" ]; then
    api PUT "/userfields/userentity-tickets/$OBJECT_ID" \
      "$(jq -nc '$ARGS.positional | map({(.): ""}) | add' --args "${TICKET_FIELDS[@]}")" >/dev/null
    api DELETE "/objects/userobjects/$OBJECT_ID" >/dev/null && echo "deleted userobject $OBJECT_ID"
  fi
  if [ -n "$STOCK_ID" ]; then
    api PUT "/userfields/stock/$STOCK_ID" '{"date_manual":""}' >/dev/null
  fi
  if [ -n "$PRODUCT_ID" ]; then
    api PUT "/userfields/products/$PRODUCT_ID" '{"ingredients":"","cooked_on":"","shelf_status":""}' >/dev/null
    api DELETE "/objects/products/$PRODUCT_ID" >/dev/null && echo "deleted product $PRODUCT_ID"
  fi
  verify_clean || status=1
  echo "exit $status"
  exit $status
}

verify_clean() {
  local bad=0 left
  left=$(api GET "/objects/products?query%5B%5D=name~ZZ" | jq length)
  [ "$left" == "0" ] && ok "no ZZ products left" || { echo "FAIL $left ZZ products left" >&2; bad=1; }
  if [ -n "$PRODUCT_ID" ]; then
    left=$(api GET "/objects/stock?query%5B%5D=product_id%3D$PRODUCT_ID" | jq length)
    [ "$left" == "0" ] && ok "no stock rows for product $PRODUCT_ID" || { echo "FAIL stock rows left" >&2; bad=1; }
    left=$(api GET "/objects/stock_log?query%5B%5D=product_id%3D$PRODUCT_ID" | jq length)
    [ "$left" == "0" ] && ok "no stock_log rows for product $PRODUCT_ID" || { echo "FAIL stock_log rows left" >&2; bad=1; }
    left=$(api GET "/userfields/products/$PRODUCT_ID" | jq '[.[] | select(. != null)] | length')
    [ "$left" == "0" ] && ok "no product userfield values for $PRODUCT_ID" || { echo "FAIL product values left" >&2; bad=1; }
  fi
  if [ -n "$STOCK_ID" ]; then
    left=$(api GET "/userfields/stock/$STOCK_ID" | jq '[.[] | select(. != null)] | length')
    [ "$left" == "0" ] && ok "no stock userfield values for $STOCK_ID" || { echo "FAIL stock values left" >&2; bad=1; }
  fi
  if [ -n "$OBJECT_ID" ]; then
    left=$(api GET "/objects/userobjects?query%5B%5D=id%3D$OBJECT_ID" | jq length)
    [ "$left" == "0" ] && ok "userobject $OBJECT_ID gone" || { echo "FAIL userobject left" >&2; bad=1; }
    left=$(api GET "/userfields/userentity-tickets/$OBJECT_ID" | jq '[.[] | select(. != null)] | length')
    [ "$left" == "0" ] && ok "no ticket userfield values for $OBJECT_ID" || { echo "FAIL ticket values left" >&2; bad=1; }
  fi
  local counts
  counts=$(counts_now)
  [ "$counts" == "$BASELINE" ] && ok "counts back to baseline: $counts" || { echo "FAIL counts $counts vs $BASELINE" >&2; bad=1; }
  return $bad
}

counts_now() {
  local out=""
  for e in products stock product_groups locations userfields userentities userobjects shopping_list; do
    out+="$e=$(api GET "/objects/$e" | jq length) "
  done
  out+="volatile=$(api GET '/stock/volatile?due_soon_days=5' | jq -c '[.due_products, .overdue_products, .expired_products, .missing_products] | map(length)')"
  printf '%s' "$out"
}

echo "--- preconditions"
auto_add=$(api GET /user/settings/shopping_list_auto_add_below_min_stock_amount | jq -r .value)
case "$auto_add" in true|1) fail "shopping list auto add is on, a product POST would touch real lists" ;; esac
[ "$(api GET "/objects/products?query%5B%5D=name~ZZ" | jq length)" == "0" ] || fail "ZZ products already exist, clean them first"
GROUP_ID=$(id_by_name product_groups "Plats cuisinés")
TICKETS_ID=$(id_by_name userentities tickets)
[ -n "$GROUP_ID" ] && [ -n "$TICKETS_ID" ] || fail "schema missing, run grocy-schema.sh first"
BASELINE=$(counts_now)
echo "baseline $BASELINE"
trap cleanup EXIT

echo "--- product"
PRODUCT_ID=$(api POST /objects/products "$(jq -nc --argjson g "$GROUP_ID" '{name: "ZZ test plat",
  product_group_id: $g, location_id: 2, qu_id_purchase: 2, qu_id_stock: 2, due_type: 2,
  default_best_before_days: 3, default_best_before_days_after_freezing: 90,
  default_best_before_days_after_thawing: 2}')" | jq -r .created_object_id)
ok "product ZZ test plat id $PRODUCT_ID"
api PUT "/userfields/products/$PRODUCT_ID" \
  "$(jq -nc --arg d "$TODAY" '{ingredients: "ZZ pâtes, tomate, basilic", cooked_on: $d, shelf_status: "pending"}')" >/dev/null
uf=$(api GET "/userfields/products/$PRODUCT_ID")
expect "product userfield ingredients" "$(jq -r .ingredients <<<"$uf")" "ZZ pâtes, tomate, basilic"
expect "product userfield cooked_on" "$(jq -r .cooked_on <<<"$uf")" "$TODAY"
expect "product userfield shelf_status" "$(jq -r .shelf_status <<<"$uf")" "pending"

echo "--- add batch (self-production)"
add=$(api POST "/stock/products/$PRODUCT_ID/add" "$(jq -nc --arg b "$(today_plus 3)" --arg p "$TODAY" \
  '{amount: 2, best_before_date: $b, location_id: 2, transaction_type: "self-production", purchased_date: $p}')")
STOCK_ID=$(jq -r '.[0].stock_id' <<<"$add")
ADD_TX=$(jq -r '.[0].transaction_id' <<<"$add")
expect "add transaction_type" "$(jq -r '.[0].transaction_type' <<<"$add")" "self-production"
ok "stock_id $STOCK_ID transaction_id $ADD_TX"

echo "--- trap 0196: stock userfield first write"
api PUT "/userfields/stock/$STOCK_ID" '{"date_manual":"1"}' >/dev/null
expect "write keyed by stock_id is dropped" "$(api GET "/userfields/stock/$STOCK_ID" | jq -r .date_manual)" "null"
api PUT "/userfields/stock/$ADD_TX" '{"date_manual":"1"}' >/dev/null
expect "write keyed by self-production add transaction_id is dropped" \
  "$(api GET "/userfields/stock/$STOCK_ID" | jq -r .date_manual)" "null"

echo "--- read back and move the date by one day (PUT full entry)"
entry=$(entry_at $FRIDGE)
ENTRY_ID=$(jq -r .id <<<"$entry")
expect "entry amount" "$(jq -r .amount <<<"$entry")" "2"
expect "entry best_before_date" "$(jq -r .best_before_date <<<"$entry")" "$(today_plus 3)"
body=$(jq -c --arg b "$(today_plus 4)" '{amount, best_before_date: $b, purchased_date, location_id,
  shopping_location_id, price, open: (.open == 1), note}' <<<"$entry")
edit=$(api PUT "/stock/entry/$ENTRY_ID" "$body")
EDIT_TX=$(jq -r '[.[] | select(.transaction_type == "stock-edit-new")][0].transaction_id' <<<"$edit")
ok "stock-edit-new transaction_id $EDIT_TX"
api PUT "/userfields/stock/$EDIT_TX" '{"date_manual":"1"}' >/dev/null
expect "write keyed by PUT transaction_id sticks" "$(api GET "/userfields/stock/$STOCK_ID" | jq -r .date_manual)" "1"
entry=$(entry_at $FRIDGE)
expect "read back best_before_date" "$(jq -r .best_before_date <<<"$entry")" "$(today_plus 4)"
expect "read back purchased_date" "$(jq -r .purchased_date <<<"$entry")" "$TODAY"
expect "read back stock_id unchanged" "$(jq -r .stock_id <<<"$entry")" "$STOCK_ID"
expect "read back userfields.date_manual" "$(jq -r .userfields.date_manual <<<"$entry")" "1"

echo "--- transfer 1 to Congélateur"
api POST "/stock/products/$PRODUCT_ID/transfer" "$(jq -nc --arg s "$STOCK_ID" \
  '{amount: 1, location_id_from: 2, location_id_to: 4, stock_entry_id: $s}')" >/dev/null
frozen=$(entry_at $FREEZER)
expect "freezer amount" "$(jq -r .amount <<<"$frozen")" "1"
expect "freezer due date (after_freezing 90)" "$(jq -r .best_before_date <<<"$frozen")" "$(today_plus 90)"
expect "freezer part keeps stock_id" "$(jq -r .stock_id <<<"$frozen")" "$STOCK_ID"
expect "freezer part shares date_manual" "$(jq -r .userfields.date_manual <<<"$frozen")" "1"
expect "fridge amount" "$(jq -r .amount <<<"$(entry_at $FRIDGE)")" "1"

echo "--- consume 1 spoiled (fridge part)"
consume=$(api POST "/stock/products/$PRODUCT_ID/consume" "$(jq -nc --arg s "$STOCK_ID" \
  '{amount: 1, spoiled: true, location_id: 2, stock_entry_id: $s}')")
expect "consume log spoiled" "$(jq -r '.[0].spoiled' <<<"$consume")" "1"
expect "fridge part gone" "$(entry_at $FRIDGE)" ""
expect "freezer part still there" "$(jq -r .amount <<<"$(entry_at $FREEZER)")" "1"

echo "--- ticket userobject"
OBJECT_ID=$(api POST /objects/userobjects "$(jq -nc --argjson e "$TICKETS_ID" '{userentity_id: $e}')" | jq -r .created_object_id)
ok "userobject tickets id $OBJECT_ID"
LINES='[{"label":"ZZ test LAIT 1L","product_id":null,"qty":2,"unit":"pc","unit_price":0.99,"total":1.98,"is_discount":false,"vat_code":"A","matched_by":"none"},{"label":"ZZ test REMISE <5%> & co","product_id":null,"qty":1,"unit":"pc","unit_price":-0.5,"total":-0.5,"is_discount":true,"vat_code":"A","matched_by":"none"}]'
ticket=$(jq -nc --arg d "$TODAY" --arg l "$LINES" '{store: "ZZ test magasin", purchased_at: $d, total: "1.48",
  currency: "EUR", status: "parsed", lines_json: $l, raw_ocr: "ZZ test LAIT 1L 0,99\nZZ test REMISE -0,50", parser: "zz-test"}')
api PUT "/userfields/userentity-tickets/$OBJECT_ID" "$ticket" >/dev/null
back=$(api GET "/userfields/userentity-tickets/$OBJECT_ID")
for f in "${TICKET_FIELDS[@]}"; do
  expect "ticket $f" "$(jq -r --arg f "$f" '.[$f]' <<<"$back")" "$(jq -r --arg f "$f" '.[$f]' <<<"$ticket")"
done
expect "lines_json parses back as JSON" "$(jq '.lines_json | fromjson | length' <<<"$back")" "2"

echo "--- all checks passed"
