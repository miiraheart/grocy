#!/usr/bin/env bash
# Creates the phase 19 recipes and meal plan schema (19-SPEC sections 3.2 to 3.5). Schema only:
# userfields, meal plan sections, two userentities, kitchen units and their global conversions.
# It never writes a product, stock, recipe, plan row or setting. Only adds what is missing.
# Usage on audibox: bash grocy-schema-19.sh --target test|real [--yes]
#   --target test -> https://grocy-test.audibox.cc only (same API key as the real Grocy)
#   --target real -> GROCY_URL of the secrets file, refused without --yes and when it is grocy-test
# On the Mac: GROCY_SECRETS=$HOME/.config/grocy/credentials bash grocy-schema-19.sh --target test
set -euo pipefail

usage() { echo "usage: $0 --target test|real [--yes]" >&2; exit 2; }

TARGET=""
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target) [ $# -ge 2 ] || usage; TARGET=$2; shift 2 ;;
    --yes) YES=1; shift ;;
    *) usage ;;
  esac
done
case "$TARGET" in test|real) ;; *) usage ;; esac
if [ "$TARGET" = real ] && [ "$YES" != 1 ]; then
  echo "refusing: --target real writes to the real Grocy and needs --yes" >&2; exit 2
fi

. "$(dirname "$0")/grocy-lib.sh"

TEST_HOST=grocy-test.audibox.cc
if [ "$TARGET" = test ]; then
  GROCY_URL="https://$TEST_HOST"
  GROCY_API="$GROCY_URL/api"
fi
HOST=${GROCY_URL#*://}
HOST=${HOST%%/*}
echo "target: $GROCY_URL"
if [ "$TARGET" = test ] && [ "$HOST" != "$TEST_HOST" ]; then
  echo "refusing: --target test must be $TEST_HOST, got $HOST" >&2; exit 3
fi
if [ "$TARGET" = real ] && [ "$HOST" = "$TEST_HOST" ]; then
  echo "refusing: --target real points at $TEST_HOST" >&2; exit 3
fi
api GET /system/info >/dev/null || { echo "refusing: $HOST does not answer /system/info" >&2; exit 1; }

ROWS=()
CHANGES=0
REPLY_ID=""
FIELDS=$(api GET /objects/userfields)

record() {
  ROWS+=("$1|$2|$3|$4")
  if [ "$4" != "exists" ]; then CHANGES=$((CHANGES + 1)); fi
}

ensure_named() {
  local entity=$1 name=$2 body=$3
  REPLY_ID=$(id_by_name "$entity" "$name")
  if [ -n "$REPLY_ID" ]; then
    record "$entity" "$name" "$REPLY_ID" exists
    return
  fi
  REPLY_ID=$(api POST "/objects/$entity" "$body" | jq -r .created_object_id)
  record "$entity" "$name" "$REPLY_ID" created
}

ensure_userfield() {
  local entity=$1 name=$2 type=$3 caption=$4 column=$5 sort=$6 config=$7 existing drift body
  existing=$(jq -c --arg e "$entity" --arg n "$name" \
    '[.[] | select(.entity == $e and .name == $n)][0] // empty' <<<"$FIELDS")
  if [ -n "$existing" ]; then
    REPLY_ID=$(jq -r .id <<<"$existing")
    drift=$(jq -r --arg t "$type" --arg c "$caption" --argjson col "$column" --arg cfg "$config" \
      '[(select(.type != $t) | "type=\(.type)"),
        (select(.caption != $c) | "caption=\(.caption)"),
        (select(((.show_as_column_in_tables // 0) | tonumber) != $col) | "column=\(.show_as_column_in_tables)"),
        (select($cfg != "" and .config != $cfg) | "config differs")] | join(" ")' <<<"$existing")
    if [ -n "$drift" ]; then echo "WARN $entity.$name differs from spec: $drift" >&2; fi
    record "userfield $entity" "$name" "$REPLY_ID" exists
    return
  fi
  body=$(jq -nc --arg e "$entity" --arg n "$name" --arg t "$type" --arg c "$caption" \
    --argjson col "$column" --argjson s "$sort" --arg cfg "$config" \
    '{entity: $e, name: $n, type: $t, caption: $c, show_as_column_in_tables: $col, sort_number: $s}
     + (if $cfg == "" then {} else {config: $cfg} end)')
  REPLY_ID=$(api POST /objects/userfields "$body" | jq -r .created_object_id)
  FIELDS=$(api GET /objects/userfields)
  record "userfield $entity" "$name" "$REPLY_ID" created
}

ensure_named userentities mealplan_templates "$(jq -nc '{name: "mealplan_templates", caption: "Modèles de semaine",
  show_in_sidebar_menu: 0, icon_css_class: "fa-solid fa-calendar-week"}')"
ensure_named userentities mealplan_repeats "$(jq -nc '{name: "mealplan_repeats", caption: "Répétitions du menu",
  show_in_sidebar_menu: 0, icon_css_class: "fa-solid fa-repeat"}')"

# entity|name|grocy type|caption|column|preset values (comma separated)
USERFIELDS=$(cat <<'TABLE'
recipes|favori|checkbox|Favori|1|
recipes|tags|text-single-line|Étiquettes|1|
recipes|rating|number-integral|Note|1|
recipes|would_make_again|checkbox|À refaire|0|
recipes|prep_minutes|number-integral|Préparation (min)|0|
recipes|cook_minutes|number-integral|Cuisson (min)|0|
recipes|lead_minutes|number-integral|Attente (min)|0|
recipes|source_url|link|Source|0|
recipes|source_author|text-single-line|Auteur|0|
recipes|source_kind|preset-list|Origine|0|web,tiktok,instagram,youtube,facebook,pinterest,photo,book,text,manual
recipes|source_ref|text-single-line|Référence source|0|
recipes|source_notes|text-multi-line|Notes de l'auteur|0|
recipes|notes|text-multi-line|Notes perso|0|
recipes|queue|checkbox|À cuisiner bientôt|1|
recipes|diet_override|checkbox|Régime vérifié à la main|0|
recipes|diet_flags|text-single-line|Alertes régime|1|
recipes|batch_portions|number-integral|Portions batch|0|
recipes|storage_default|preset-list|Conservation|0|fridge,freezer,none
recipes|locked_servings|number-integral|Portions préférées|0|
recipes|import_status|preset-list|Import|1|pending,ready,failed,done
recipes|import_draft|text-multi-line|Brouillon d'import|0|
recipes|import_error|text-single-line|Erreur d'import|0|
recipes|import_raw|text-multi-line|Texte importé|0|
recipes_pos|optional|checkbox|Facultatif|0|
recipes_pos|fixed|checkbox|Quantité fixe|0|
recipes_pos|raw_line|text-single-line|Ligne d'origine|0|
recipes_pos|sort|number-integral|Ordre|0|
recipes_pos|steps|text-single-line|Étapes|0|
meal_plan|batch_ref|text-single-line|Lot cuisiné|0|
meal_plan|repeat_ref|text-single-line|Répétition|0|
userentity-mealplan_templates|name|text-single-line|Nom|1|
userentity-mealplan_templates|days_json|text-multi-line|Contenu|0|
userentity-mealplan_repeats|label|text-single-line|Libellé|1|
userentity-mealplan_repeats|rule_json|text-multi-line|Règle|0|
TABLE
)

prev_entity=""
sort=0
while IFS='|' read -r entity name type caption column presets; do
  if [ "$entity" != "$prev_entity" ]; then sort=0; prev_entity=$entity; fi
  sort=$((sort + 1))
  ensure_userfield "$entity" "$name" "$type" "$caption" "$column" "$sort" "${presets//,/$'\n'}"
done <<<"$USERFIELDS"

# name|sort_number|time_info (D-02)
SECTIONS='Petit déjeuner|1|08:00
Déjeuner|2|12:30
Goûter|3|16:30
Dîner|4|19:30'

while IFS='|' read -r name sort_number time_info; do
  ensure_named meal_plan_sections "$name" "$(jq -nc --arg n "$name" --argjson s "$sort_number" --arg t "$time_info" \
    '{name: $n, sort_number: $s, time_info: $t}')"
done <<<"$SECTIONS"

# name|plural|millilitres in one unit (D-28), empty = no conversion
UNITS='c.à.s.|c.à.s.|15
c.à.c.|c.à.c.|5
pincée|pincées|
tasse|tasses|240'

ML_ID=$(api GET /objects/quantity_units | jq -r \
  '[.[] | select((.name | ascii_downcase) as $n | ["ml", "millilitre", "millilitres", "milliliter"] | index($n))][0].id // empty')
if [ -z "$ML_ID" ]; then echo "WARN no ml unit, kitchen unit conversions skipped" >&2; fi
CONVERSIONS=$(api GET /objects/quantity_unit_conversions)

while IFS='|' read -r name plural ml; do
  ensure_named quantity_units "$name" "$(jq -nc --arg n "$name" --arg p "$plural" '{name: $n, name_plural: $p}')"
  unit_id=$REPLY_ID
  if [ -z "$ml" ] || [ -z "$ML_ID" ]; then continue; fi
  existing=$(jq -r --arg f "$unit_id" --arg t "$ML_ID" \
    '[.[] | select((.from_qu_id | tostring) == $f and (.to_qu_id | tostring) == $t and ((.product_id // "") | tostring) == "")][0].id // empty' \
    <<<"$CONVERSIONS")
  if [ -n "$existing" ]; then
    record quantity_unit_conversions "$name -> ml" "$existing" exists
    continue
  fi
  id=$(api POST /objects/quantity_unit_conversions "$(jq -nc --argjson f "$unit_id" --argjson t "$ML_ID" --argjson x "$ml" \
    '{from_qu_id: $f, to_qu_id: $t, factor: $x, product_id: null}')" | jq -r .created_object_id)
  record quantity_unit_conversions "$name -> ml" "$id" created
done <<<"$UNITS"

printf '\n%-36s %-28s %-10s %s\n' KIND NAME ID STATUS
for row in "${ROWS[@]}"; do
  IFS='|' read -r kind name id status <<<"$row"
  printf '%-36s %-28s %-10s %s\n' "$kind" "$name" "$id" "$status"
done
echo "changes: $CHANGES"
