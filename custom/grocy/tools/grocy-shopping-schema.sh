#!/usr/bin/env bash
# Creates the phase 17 shopping userfields (17-SPEC section 2.2, F-01 to F-64). Schema only.
# Usage: bash grocy-shopping-schema.sh [--target test|real] [--confirm-real] [--verify]
#   --target test (default) -> https://grocy-test.audibox.cc only
#   --target real           -> GROCY_URL of the secrets file, needs --confirm-real to write
#   --verify                -> read only, lists every field as present or missing, exit 1 when one is missing
# On the Mac: GROCY_SECRETS=$HOME/.config/grocy/credentials bash grocy-shopping-schema.sh --target test
set -euo pipefail

usage() { echo "usage: $0 [--target test|real] [--confirm-real] [--verify]" >&2; exit 2; }

TARGET=test
CONFIRM_REAL=0
VERIFY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target) [ $# -ge 2 ] || usage; TARGET=$2; shift 2 ;;
    --confirm-real) CONFIRM_REAL=1; shift ;;
    --verify) VERIFY=1; shift ;;
    *) usage ;;
  esac
done
case "$TARGET" in test|real) ;; *) usage ;; esac

. "$(dirname "$0")/grocy-lib.sh"

TEST_HOST=grocy-test.audibox.cc
if [ "$TARGET" = test ]; then
  GROCY_URL="https://$TEST_HOST"
  GROCY_API="$GROCY_URL/api"
fi
HOST=${GROCY_API#*://}
HOST=${HOST%%/*}
echo "target: $TARGET host: $HOST mode: $([ "$VERIFY" = 1 ] && echo verify || echo create)"

if [ "$TARGET" = test ] && [ "$HOST" != "$TEST_HOST" ]; then
  echo "refusing: test target must be $TEST_HOST" >&2; exit 1
fi
if [ "$TARGET" = real ] && [ "$HOST" = "$TEST_HOST" ]; then
  echo "refusing: real target points at $TEST_HOST, use --target test" >&2; exit 1
fi
if [ "$TARGET" = real ] && [ "$VERIFY" != 1 ] && [ "$CONFIRM_REAL" != 1 ]; then
  echo "refusing: writing to the real server ($HOST) needs --confirm-real" >&2; exit 1
fi

api GET /system/info >/dev/null || { echo "refusing: $HOST does not answer /system/info" >&2; exit 1; }

auto_add=$(api GET /user/settings/shopping_list_auto_add_below_min_stock_amount | jq -r .value)
case "$auto_add" in
  true|1|on) echo "shopping_list_auto_add_below_min_stock_amount is on, stopping (suggestions are never added silently)" >&2; exit 1 ;;
esac

# entity|name|grocy type|caption|preset values (comma separated)
FIELD_LIST='shopping_list|al_note|text-multi-line|Item note (free text items)|
shopping_list|al_qty_text|text-single-line|Quantity text|
shopping_list|al_package|text-single-line|Package size|
shopping_list|al_price|number-decimal|Price|
shopping_list|al_price_qty|number-decimal|Quantity for total cost|
shopping_list|al_stores|text-single-line|Stores|
shopping_list|al_category|text-single-line|Category|
shopping_list|al_position|number-decimal|Position|
shopping_list|al_added_by|number-integral|Added by|
shopping_list|al_crossed_at|datetime|Crossed at|
shopping_list|al_recipes|text-multi-line|Recipe shares|
shopping_list|al_source|text-single-line|Source|
shopping_list|al_flags|text-single-line|Flags|
shopping_lists|al_type|preset-list|List type|grocery,categorized,simple
shopping_lists|al_icon|text-single-line|Icon|
shopping_lists|al_theme|text-single-line|Theme|
shopping_lists|al_folder|text-single-line|Folder|
shopping_lists|al_order|number-decimal|Order|
shopping_lists|al_sort|preset-list|Sort order|manual,alpha
shopping_lists|al_insert|preset-list|Insert new items|top,bottom
shopping_lists|al_headers|preset-list|Show category headers|on,off
shopping_lists|al_hide_crossed|preset-list|Hide crossed off items|on,off
shopping_lists|al_autocomplete|preset-list|Grocery autocomplete|on,off
shopping_lists|al_show_prices|preset-list|Show prices in list|on,off
shopping_lists|al_show_store_names|preset-list|Show store names in list|on,off
shopping_lists|al_totals|preset-list|Show running totals|on,off
shopping_lists|al_total_left|preset-list|Left total|all,crossed,remaining
shopping_lists|al_total_right|preset-list|Right total|all,crossed,remaining
shopping_lists|al_badge|preset-list|Include in app badge|on,off
shopping_lists|al_notify|preset-list|Notify on changes by others|on,off
shopping_lists|al_passcode|text-single-line|Passcode|
shopping_lists|al_stores|text-single-line|Stores in this list|
shopping_lists|al_categories|text-multi-line|Categories (app data)|
shopping_lists|al_filters|text-multi-line|Filters (app data)|
shopping_lists|al_starters|text-multi-line|Starter lists (app data)|
shopping_lists|al_memory|text-multi-line|Free text item memory (app data)|
shopping_lists|al_places|text-multi-line|Location reminders (app data)|
products|al_memory|text-multi-line|List memory (app data)|
products|al_store_prices|text-multi-line|Store prices (app data)|
shopping_locations|al_geo|text-single-line|Location|
shopping_locations|al_aisles|text-multi-line|Learned aisle order (app data)|
shopping_locations|al_card|text-single-line|Loyalty card|
shopping_locations|al_perks|text-multi-line|Perks|
shopping_locations|al_icon|text-single-line|Icon|'

ROWS=()
CHANGES=0
MISSING=0
FIELDS=$(api GET /objects/userfields)

record() {
  ROWS+=("$1|$2|$3|$4")
  case "$4" in
    created) CHANGES=$((CHANGES + 1)) ;;
    missing) MISSING=$((MISSING + 1)) ;;
  esac
}

existing_field() {
  jq -c --arg e "$1" --arg n "$2" '[.[] | select(.entity == $e and .name == $n)][0] // empty' <<<"$FIELDS"
}

next_sort() {
  jq -r --arg e "$1" '[.[] | select(.entity == $e) | (.sort_number // 0 | tonumber)] | (max // 0) + 1' <<<"$FIELDS"
}

warn_drift() {
  local entity=$1 name=$2 type=$3 caption=$4 config=$5 existing=$6 drift
  drift=$(jq -r --arg t "$type" --arg c "$caption" --arg cfg "$config" \
    '[(select(.type != $t) | "type=\(.type)"),
      (select(.caption != $c) | "caption=\(.caption)"),
      (select((.show_as_column_in_tables | tonumber) != 0) | "column=\(.show_as_column_in_tables)"),
      (select($cfg != "" and .config != $cfg) | "config differs")] | join(" ")' <<<"$existing")
  if [ -n "$drift" ]; then echo "WARN $entity.$name differs from spec: $drift" >&2; fi
}

ensure_field() {
  local entity=$1 name=$2 type=$3 caption=$4 config=$5 existing body id sort
  existing=$(existing_field "$entity" "$name")
  if [ -n "$existing" ]; then
    warn_drift "$entity" "$name" "$type" "$caption" "$config" "$existing"
    record "userfield $entity" "$name" "$(jq -r .id <<<"$existing")" "$([ "$VERIFY" = 1 ] && echo present || echo exists)"
    return
  fi
  if [ "$VERIFY" = 1 ]; then
    record "userfield $entity" "$name" - missing
    return
  fi
  sort=$(next_sort "$entity")
  body=$(jq -nc --arg e "$entity" --arg n "$name" --arg t "$type" --arg c "$caption" \
    --argjson s "$sort" --arg cfg "$config" \
    '{entity: $e, name: $n, type: $t, caption: $c, show_as_column_in_tables: 0, sort_number: $s}
     + (if $cfg == "" then {} else {config: $cfg} end)')
  id=$(api POST /objects/userfields "$body" | jq -r .created_object_id)
  FIELDS=$(api GET /objects/userfields)
  record "userfield $entity" "$name" "$id" created
}

if [ "$TARGET" = real ] && [ "$VERIFY" != 1 ]; then
  echo "fields to create on $HOST:"
  planned=0
  while IFS='|' read -r entity name type caption presets; do
    if [ -z "$(existing_field "$entity" "$name")" ]; then
      echo "  $entity.$name ($type)"
      planned=$((planned + 1))
    fi
  done <<<"$FIELD_LIST"
  echo "planned: $planned"
fi

while IFS='|' read -r entity name type caption presets; do
  ensure_field "$entity" "$name" "$type" "$caption" "${presets//,/$'\n'}"
done <<<"$FIELD_LIST"

printf '\n%-30s %-22s %-8s %s\n' KIND NAME ID STATUS
for row in "${ROWS[@]}"; do
  IFS='|' read -r kind name id status <<<"$row"
  printf '%-30s %-22s %-8s %s\n' "$kind" "$name" "$id" "$status"
done

if [ "$VERIFY" = 1 ]; then
  echo "missing: $MISSING"
  [ "$MISSING" = 0 ] || exit 1
  exit 0
fi
echo "changes: $CHANGES"
