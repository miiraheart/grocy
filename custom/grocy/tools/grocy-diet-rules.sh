#!/usr/bin/env bash
# Publishes the app diet rules file (GrocyV2/Resources/DietRules.json) to Grocy file storage as
# userfiles/diet-rules.json, where grocy-mcp reads it (19-SPEC 4.8). Deletes the old copy, uploads,
# reads it back and compares the bytes. Writes nothing else.
# Usage on audibox: bash grocy-diet-rules.sh [rules file] --target test|real [--yes]
#   rules file    -> default /home/miira/apps/docker/grocy/diet/DietRules.json
#   --target test -> https://grocy-test.audibox.cc only (same API key as the real Grocy)
#   --target real -> GROCY_URL of the secrets file, refused without --yes and when it is grocy-test
set -euo pipefail

usage() { echo "usage: $0 [rules file] --target test|real [--yes]" >&2; exit 2; }

FILE=/home/miira/apps/docker/grocy/diet/DietRules.json
TARGET=""
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target) [ $# -ge 2 ] || usage; TARGET=$2; shift 2 ;;
    --yes) YES=1; shift ;;
    -*) usage ;;
    *) FILE=$1; shift ;;
  esac
done
case "$TARGET" in test|real) ;; *) usage ;; esac
if [ "$TARGET" = real ] && [ "$YES" != 1 ]; then
  echo "refusing: --target real writes to the real Grocy and needs --yes" >&2; exit 2
fi

. "$(dirname "$0")/grocy-lib.sh"

[ -f "$FILE" ] || { echo "missing rules file: $FILE" >&2; exit 1; }
VERSION=$(jq -er '.version' "$FILE") || { echo "not a rules file (no version): $FILE" >&2; exit 1; }
jq -e '(.rules | length > 0) and (.recipe.swaps | length > 0)' "$FILE" >/dev/null \
  || { echo "not a rules file (no rules or no recipe swaps): $FILE" >&2; exit 1; }

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

NAME=$(printf '%s' diet-rules.json | base64 | tr -d '\n')
URL="$GROCY_API/files/userfiles/$NAME"
BACK=$(mktemp)
trap 'rm -f "$BACK"' EXIT

# The API key goes to curl on stdin as a config line, never on the command line.
files_call() {
  local method=$1
  shift
  printf 'header = "GROCY-API-KEY: %s"\n' "$GROCY_API_KEY" \
    | curl -sS -K - -o "$BACK" -w '%{http_code}' -X "$method" "$@" "$URL"
}

code=$(files_call DELETE)
case "$code" in
  2*|404) echo "deleted old userfiles/diet-rules.json ($code)" ;;
  *) echo "FAIL DELETE userfiles/diet-rules.json -> HTTP $code $(cat "$BACK")" >&2; exit 1 ;;
esac

code=$(files_call PUT -H 'Content-Type: application/octet-stream' --data-binary "@$FILE")
[ "${code:0:1}" = 2 ] || { echo "FAIL PUT userfiles/diet-rules.json -> HTTP $code $(cat "$BACK")" >&2; exit 1; }

code=$(files_call GET)
[ "${code:0:1}" = 2 ] || { echo "FAIL GET userfiles/diet-rules.json -> HTTP $code" >&2; exit 1; }
if ! cmp -s "$FILE" "$BACK"; then
  echo "FAIL read back differs from $FILE ($(wc -c <"$FILE") vs $(wc -c <"$BACK") bytes)" >&2; exit 1
fi
echo "same bytes: userfiles/diet-rules.json on $HOST, version $VERSION ($(wc -c <"$FILE" | tr -d ' ') bytes)"
