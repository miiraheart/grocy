#!/usr/bin/env bash
# Creates the kitchen companion schema on Grocy (13-SCHEMA.md). Only adds what is missing.
# Usage on audibox: bash grocy-schema.sh
set -euo pipefail
. "$(dirname "$0")/grocy-lib.sh"

ROWS=()
CHANGES=0
REPLY_ID=""

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
  local entity=$1 name=$2 type=$3 caption=$4 column=$5 sort=$6 config=$7 existing body
  existing=$(api GET /objects/userfields | jq -c --arg e "$entity" --arg n "$name" \
    '[.[] | select(.entity == $e and .name == $n)][0] // empty')
  if [ -n "$existing" ]; then
    REPLY_ID=$(jq -r .id <<<"$existing")
    local drift
    drift=$(jq -r --arg t "$type" --arg c "$caption" --argjson col "$column" --arg cfg "$config" \
      '[(select(.type != $t) | "type=\(.type)"),
        (select(.caption != $c) | "caption=\(.caption)"),
        (select((.show_as_column_in_tables | tonumber) != $col) | "column=\(.show_as_column_in_tables)"),
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
  record "userfield $entity" "$name" "$REPLY_ID" created
}

auto_add=$(api GET /user/settings/shopping_list_auto_add_below_min_stock_amount | jq -r .value)
case "$auto_add" in
  true|1|"\"1\"") echo "shopping_list_auto_add_below_min_stock_amount is on, stopping (product PUT would fill a list)" >&2; exit 1 ;;
esac

ensure_named locations "Plan de travail" \
  "$(jq -nc '{name: "Plan de travail", description: "Fruits, légumes et pain gardés hors du frigo", is_freezer: 0}')"

for group in "Plats cuisinés" "Fruits et légumes" "Produits laitiers et œufs" "Viande et poisson" \
  "Épicerie" "Boissons" "Surgelés" "Hygiène et maison"; do
  ensure_named product_groups "$group" "$(jq -nc --arg n "$group" '{name: $n}')"
done

for store in "La Vie Claire" "Biocoop" "Naturalia" "Carrefour" "Monoprix" "Marché"; do
  ensure_named shopping_locations "$store" "$(jq -nc --arg n "$store" '{name: $n}')"
done

ensure_named userentities cuisine "$(jq -nc '{name: "cuisine", caption: "Cuisine",
  show_in_sidebar_menu: 1, icon_css_class: "fa-solid fa-kitchen-set"}')"
ensure_named userentities tickets "$(jq -nc '{name: "tickets", caption: "Tickets de caisse",
  show_in_sidebar_menu: 1, icon_css_class: "fa-solid fa-receipt"}')"

# entity|name|grocy type|caption|column|preset values (comma separated)
USERFIELDS='products|ingredients|text-multi-line|Ingrédients|0|
products|cooked_on|date|Cuisiné le|0|
products|shelf_fridge_days|number-integral|Jours au frais|0|
products|shelf_freezer_days|number-integral|Jours au congélateur|0|
products|shelf_counter_days|number-integral|Jours hors frigo|0|
products|shelf_after_open_days|number-integral|Jours après ouverture|0|
products|shelf_confidence|number-decimal|Confiance estimation|0|
products|shelf_notes|text-multi-line|Notes conservation|0|
products|shelf_status|preset-list|Estimation|1|none,pending,done,manual,failed
products|shelf_source|text-single-line|Source estimation|0|
products|shelf_updated|date|Estimé le|0|
products|favori|checkbox|Favori|1|
products|receipt_aliases|text-multi-line|Alias tickets|0|
products|needs_scan|checkbox|À scanner|1|
products|tags|text-single-line|Étiquettes|0|
stock|date_manual|checkbox|Date fixée à la main|0|
recipes|favori|checkbox|Favori|1|
userentity-cuisine|note|text-multi-line|Note|1|
userentity-tickets|store|text-single-line|Magasin|1|
userentity-tickets|purchased_at|date|Date|1|
userentity-tickets|total|number-currency|Total|1|
userentity-tickets|currency|text-single-line|Devise|0|
userentity-tickets|status|preset-list|Statut|1|parsed,confirmed,applied
userentity-tickets|lines_json|text-multi-line|Lignes (JSON)|0|
userentity-tickets|raw_ocr|text-multi-line|OCR brut|0|
userentity-tickets|image|file|Photo|0|
userentity-tickets|parser|text-single-line|Parseur|0|'

prev_entity=""
sort=0
while IFS='|' read -r entity name type caption column presets; do
  if [ "$entity" != "$prev_entity" ]; then sort=0; prev_entity=$entity; fi
  sort=$((sort + 1))
  ensure_userfield "$entity" "$name" "$type" "$caption" "$column" "$sort" "${presets//,/$'\n'}"
done <<<"$USERFIELDS"

due_soon=$(api GET /user/settings/stock_due_soon_days | jq -r .value)
if [ "$due_soon" != "5" ]; then
  api PUT /user/settings/stock_due_soon_days '{"value":"5"}' >/dev/null
  record setting stock_due_soon_days 5 updated
else
  record setting stock_due_soon_days 5 exists
fi

# name fragment|group, for the products that existed before the schema
ENRICH='Beurre moulé|Produits laitiers et œufs
Crème fra|Produits laitiers et œufs
Mascarpone|Produits laitiers et œufs
Œufs|Produits laitiers et œufs
Chocolat|Épicerie
Pruneaux|Épicerie'

products=$(api GET /objects/products)
while IFS='|' read -r fragment group; do
  gid=$(id_by_name product_groups "$group")
  matches=$(jq -c --arg f "$fragment" '[.[] | select(.name | ascii_downcase | contains($f | ascii_downcase))]' <<<"$products")
  if [ "$(jq length <<<"$matches")" != "1" ]; then
    echo "WARN product '$fragment' matched $(jq length <<<"$matches") products, skipped" >&2
    continue
  fi
  pid=$(jq -r '.[0].id' <<<"$matches")
  current=$(jq -r '.[0].product_group_id // empty' <<<"$matches")
  if [ -z "$current" ]; then
    api PUT "/objects/products/$pid" "$(jq -nc --argjson g "$gid" '{product_group_id: $g}')" >/dev/null
    record "product group" "$(jq -r '.[0].name' <<<"$matches")" "$pid -> $gid" updated
  else
    record "product group" "$(jq -r '.[0].name' <<<"$matches")" "$pid -> $current" exists
  fi
done <<<"$ENRICH"

printf '\n%-28s %-32s %-10s %s\n' KIND NAME ID STATUS
for row in "${ROWS[@]}"; do
  IFS='|' read -r kind name id status <<<"$row"
  printf '%-28s %-32s %-10s %s\n' "$kind" "$name" "$id" "$status"
done
echo "changes: $CHANGES"
