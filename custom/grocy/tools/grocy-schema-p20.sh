#!/usr/bin/env bash
# Creates the phase 20 userfields (20-SPEC section 6). Schema only, dry run by default.
# Usage: bash grocy-schema-p20.sh test|real [--apply] [--real-pantry]
#   test  -> https://grocy-test.audibox.cc only
#   real  -> GROCY_URL of the secrets file, must be grocy.audibox.cc; writing needs --apply --real-pantry
# On the Mac: GROCY_SECRETS=$HOME/.config/grocy/credentials bash grocy-schema-p20.sh test --apply
set -euo pipefail

usage() { echo "usage: $0 test|real [--apply] [--real-pantry]" >&2; exit 2; }

TARGET=${1:-}
case "$TARGET" in test|real) shift ;; *) usage ;; esac
APPLY=0
REAL_PANTRY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --real-pantry) REAL_PANTRY=1 ;;
    *) usage ;;
  esac
done

. "$(dirname "$0")/grocy-lib.sh"

if [ "$TARGET" = test ]; then
  GROCY_API="https://grocy-test.audibox.cc/api"
fi
HOST=${GROCY_API#*://}
HOST=${HOST%%/*}
echo "target: $TARGET host: $HOST mode: $([ "$APPLY" = 1 ] && echo apply || echo dry-run)"

if [ "$TARGET" = test ] && [ "$HOST" != grocy-test.audibox.cc ]; then
  echo "refusing: test target must be grocy-test.audibox.cc" >&2; exit 2
fi
if [ "$TARGET" = test ] && [ "$REAL_PANTRY" = 1 ]; then
  echo "refusing: --real-pantry only goes with real" >&2; exit 2
fi
if [ "$TARGET" = real ] && [ "$HOST" != grocy.audibox.cc ]; then
  echo "refusing: real target must be grocy.audibox.cc" >&2; exit 2
fi
if [ "$TARGET" = real ] && [ "$APPLY" = 1 ] && [ "$REAL_PANTRY" != 1 ]; then
  echo "refusing: writing to the real pantry needs --apply --real-pantry" >&2; exit 2
fi

ROWS=()
CHANGES=0
PENDING=0
FIELDS=$(api GET /objects/userfields)

record() {
  ROWS+=("$1|$2|$3|$4")
  case "$4" in
    created) CHANGES=$((CHANGES + 1)) ;;
    would-create) PENDING=$((PENDING + 1)) ;;
  esac
}

next_sort() {
  jq -r --arg e "$1" '[.[] | select(.entity == $e) | (.sort_number // 0 | tonumber)] | (max // 0) + 1' <<<"$FIELDS"
}

ensure_field() {
  local entity=$1 name=$2 type=$3 caption=$4 config=$5 existing drift body id sort
  existing=$(jq -c --arg e "$entity" --arg n "$name" \
    '[.[] | select(.entity == $e and .name == $n)][0] // empty' <<<"$FIELDS")
  if [ -n "$existing" ]; then
    drift=$(jq -r --arg t "$type" --arg c "$caption" --arg cfg "$config" \
      '[(select(.type != $t) | "type=\(.type)"),
        (select(.caption != $c) | "caption=\(.caption)"),
        (select((.show_as_column_in_tables | tonumber) != 0) | "column=\(.show_as_column_in_tables)"),
        (select($cfg != "" and .config != $cfg) | "config differs")] | join(" ")' <<<"$existing")
    if [ -n "$drift" ]; then echo "WARN $entity.$name differs from spec: $drift" >&2; fi
    record "userfield $entity" "$name" "$(jq -r .id <<<"$existing")" exists
    return
  fi
  if [ "$APPLY" != 1 ]; then
    record "userfield $entity" "$name" - would-create
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

ICONS="dish produce dairy meat grocery drinks frozen household bakery spices snacks health first_aid beauty textiles tools pets tag"
COLORS="red orange yellow green mint teal cyan blue indigo purple pink brown gray"
lines() { tr ' ' '\n' <<<"$1"; }

ensure_field products reminder_days text-single-line "Rappels (jours avant)" ""
ensure_field products restock_on checkbox "Rappel de réapprovisionnement" ""
ensure_field products restock_unit preset-list "Réapprovisionner : unité" "$(lines "day week month")"
ensure_field products restock_every number-integral "Réapprovisionner tous les" ""
ensure_field products restock_next date "Prochain réapprovisionnement" ""
ensure_field product_groups icon preset-list "Icône" "$(lines "$ICONS")"
ensure_field product_groups color preset-list "Couleur" "$(lines "$COLORS")"

printf '\n%-28s %-32s %-10s %s\n' KIND NAME ID STATUS
for row in "${ROWS[@]}"; do
  IFS='|' read -r kind name id status <<<"$row"
  printf '%-28s %-32s %-10s %s\n' "$kind" "$name" "$id" "$status"
done
if [ "$APPLY" != 1 ]; then echo "dry run, would-create: $PENDING"; fi
echo "changes: $CHANGES"
