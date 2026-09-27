#!/usr/bin/env bash
# Moves the global product favorites (userfield favori) into favorites of list 1 (17-SPEC 2.6, D-05).
# Merges {"fav":true,"favAt":<now>} plus amount 1 and the purchase unit when they are not remembered yet into
# products.al_memory lists["1"], keeping every other key. Never writes favori. Dry run unless --apply.
# Usage: bash grocy-shopping-migrate.sh [--target test|real] [--apply] [--confirm-real]
#   --target test (default) -> https://grocy-test.audibox.cc only
#   --target real           -> GROCY_URL of the secrets file; --apply there needs --confirm-real
# On the Mac: GROCY_SECRETS=$HOME/.config/grocy/credentials bash grocy-shopping-migrate.sh --target test
set -euo pipefail

usage() { echo "usage: $0 [--target test|real] [--apply] [--confirm-real]" >&2; exit 2; }

TARGET=test
APPLY=0
CONFIRM_REAL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target) [ $# -ge 2 ] || usage; TARGET=$2; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --confirm-real) CONFIRM_REAL=1; shift ;;
    *) usage ;;
  esac
done
case "$TARGET" in test|real) ;; *) usage ;; esac

GROCY_LIB=${GROCY_LIB:-$(dirname "$0")/grocy-lib.sh}
[ -f "$GROCY_LIB" ] || GROCY_LIB=/Users/kbs/projects/grocy-server/custom/grocy/tools/grocy-lib.sh
. "$GROCY_LIB"

TEST_HOST=grocy-test.audibox.cc
LIST_ID=1
if [ "$TARGET" = test ]; then
  GROCY_URL="https://$TEST_HOST"
  GROCY_API="$GROCY_URL/api"
fi
HOST=${GROCY_API#*://}
HOST=${HOST%%/*}
echo "target: $TARGET host: $HOST mode: $([ "$APPLY" = 1 ] && echo apply || echo dry-run)"

if [ "$TARGET" = test ] && [ "$HOST" != "$TEST_HOST" ]; then
  echo "refusing: test target must be $TEST_HOST" >&2; exit 1
fi
if [ "$TARGET" = real ] && [ "$HOST" = "$TEST_HOST" ]; then
  echo "refusing: real target points at $TEST_HOST, use --target test" >&2; exit 1
fi
if [ "$TARGET" = real ] && [ "$APPLY" = 1 ] && [ "$CONFIRM_REAL" != 1 ]; then
  echo "refusing: writing to the real server ($HOST) needs --apply --confirm-real" >&2; exit 1
fi

api GET /system/info >/dev/null || { echo "refusing: $HOST does not answer /system/info" >&2; exit 1; }

auto_add=$(api GET /user/settings/shopping_list_auto_add_below_min_stock_amount | jq -r .value)
case "$auto_add" in
  true|1|on) echo "shopping_list_auto_add_below_min_stock_amount is on, stopping" >&2; exit 1 ;;
esac

has_memory=$(api GET /objects/userfields | jq '[.[] | select(.entity == "products" and .name == "al_memory")] | length')
if [ "$has_memory" = 0 ]; then
  echo "products.al_memory is missing, run grocy-shopping-schema.sh --target $TARGET first" >&2; exit 1
fi

list_name=$(api GET "/objects/shopping_lists/$LIST_ID" | jq -r '.name // empty')
if [ -z "$list_name" ]; then echo "list $LIST_ID does not exist on $HOST" >&2; exit 1; fi
echo "favorites go to list $LIST_ID: $list_name"

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
products=$(api GET /objects/products | jq -c '[.[] | select((.userfields.favori // "") | tostring == "1")]')
CHANGES=0
PENDING=0

printf '\n%-6s %-36s %-18s %-18s %s\n' ID NAME BEFORE AFTER STATUS
while IFS= read -r product; do
  [ -n "$product" ] || continue
  id=$(jq -r .id <<<"$product")
  name=$(jq -r .name <<<"$product")
  before=$(jq -r '.userfields.al_memory // ""' <<<"$product")
  if [ -n "$before" ] && ! jq -e 'type == "object"' <<<"$before" >/dev/null 2>&1; then
    printf '%-6s %-36.36s %-18s %-18s %s\n' "$id" "$name" broken - "skipped (al_memory is not a JSON object)"
    continue
  fi
  after=$(jq -c --arg list "$LIST_ID" --arg now "$NOW" --argjson qu "$(jq '.qu_id_purchase // null' <<<"$product")" '
    (if . == null then {v: 1} else . end) as $doc
    | ($doc.lists[$list] // {}) as $entry
    | if $entry.fav == true then $doc
      else $doc | .v = (.v // 1) | .lists[$list] = ($entry + {fav: true, favAt: $now}
        + (if $entry.amount == null then {amount: 1} else {} end)
        + (if $entry.qu == null and $qu != null then {qu: ($qu | tonumber)} else {} end))
      end' <<<"${before:-null}")
  was=$(jq -r --arg list "$LIST_ID" 'if . == null then "none" else "fav=\(.lists[$list].fav // false)" end' <<<"${before:-null}")
  now_state=$(jq -r --arg list "$LIST_ID" '"fav=\(.lists[$list].fav // false)"' <<<"$after")
  if [ -n "$before" ] && [ "$(jq -cS . <<<"$before")" = "$(jq -cS . <<<"$after")" ]; then
    status=unchanged
  elif [ "$APPLY" = 1 ]; then
    api PUT "/userfields/products/$id" "$(jq -nc --arg m "$after" '{al_memory: $m}')" >/dev/null
    status=updated
    CHANGES=$((CHANGES + 1))
  else
    status=would-update
    PENDING=$((PENDING + 1))
  fi
  printf '%-6s %-36.36s %-18s %-18s %s\n' "$id" "$name" "$was" "$now_state" "$status"
done < <(jq -c '.[]' <<<"$products")

echo "favori products: $(jq length <<<"$products")"
if [ "$APPLY" != 1 ]; then echo "dry run, would-update: $PENDING"; fi
echo "changes: $CHANGES"
