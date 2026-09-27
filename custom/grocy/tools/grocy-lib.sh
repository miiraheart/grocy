# Shared helpers for the grocy tools. Source it, do not run it.
# Runs on audibox. Reads GROCY_URL and GROCY_API_KEY from the secrets file.

GROCY_SECRETS=${GROCY_SECRETS:-/home/miira/apps/docker/grocy/grocy.secrets}
set -a
. "$GROCY_SECRETS"
set +a
GROCY_API="$GROCY_URL/api"

for bin in curl jq; do
  command -v "$bin" >/dev/null || { echo "missing $bin" >&2; exit 1; }
done

api() {
  local method=$1 path=$2 body=${3:-} out code
  local args=(-sS -w '\n%{http_code}' -X "$method" -H "GROCY-API-KEY: $GROCY_API_KEY")
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data-binary "$body")
  fi
  out=$(curl "${args[@]}" "$GROCY_API$path") || { echo "FAIL $method $path: curl error" >&2; return 1; }
  code=${out##*$'\n'}
  out=${out%$'\n'*}
  if [ "${code:0:1}" != "2" ]; then
    echo "FAIL $method $path -> HTTP $code $out" >&2
    return 1
  fi
  printf '%s' "$out"
}

id_by_name() {
  api GET "/objects/$1" | jq -r --arg n "$2" '[.[] | select(.name == $n)][0].id // empty'
}

today_plus() {
  date -d "+$1 day" +%F
}

# userfield_ensure entity name type caption column sort config mode
# mode check is read only; mode create adds the field with POST /objects/userfields when missing.
# Prints "exists", "drift <fields>", "missing" or "created <id>". Returns 1 only when still missing.
userfield_ensure() {
  local entity=$1 name=$2 type=$3 caption=$4 column=$5 sort=$6 config=$7 mode=$8 existing drift body id
  existing=$(api GET /objects/userfields | jq -c --arg e "$entity" --arg n "$name" \
    '[.[] | select(.entity == $e and .name == $n)][0] // empty') || return 2
  if [ -n "$existing" ]; then
    drift=$(jq -r --arg t "$type" --arg c "$caption" --argjson col "$column" --arg cfg "$config" \
      '[(select(.type != $t) | "type=\(.type)"),
        (select(.caption != $c) | "caption=\(.caption)"),
        (select(((.show_as_column_in_tables // 0) | tonumber) != $col) | "column=\(.show_as_column_in_tables)"),
        (select((.config // "") != $cfg) | "config=\(.config // "" | gsub("\n"; ","))")] | join(" ")' <<<"$existing")
    if [ -n "$drift" ]; then echo "$entity.$name drift $drift"; else echo "$entity.$name exists"; fi
    return 0
  fi
  if [ "$mode" != "create" ]; then
    echo "$entity.$name missing"
    return 1
  fi
  body=$(jq -nc --arg e "$entity" --arg n "$name" --arg t "$type" --arg c "$caption" \
    --argjson col "$column" --argjson s "$sort" --arg cfg "$config" \
    '{entity: $e, name: $n, type: $t, caption: $c, show_as_column_in_tables: $col, sort_number: $s}
     + (if $cfg == "" then {} else {config: $cfg} end)')
  id=$(api POST /objects/userfields "$body" | jq -r .created_object_id) || return 2
  echo "$entity.$name created $id"
}
