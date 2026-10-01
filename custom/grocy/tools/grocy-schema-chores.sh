#!/usr/bin/env bash
# Phase 18 schema (18-SPEC 3.2): the chores and tasks userfields and the web Agenda and Dashboard userentities. Writes schema only, never a data row.
# Only GET and POST /objects/userfields and /objects/userentities. Adds what is missing, reports drift, never edits a field.
# Usage: grocy-schema-chores.sh [--target test|real] [--yes-real] [--check]
#   --target test (default) talks to https://grocy-test.audibox.cc/api and nothing else.
#   --target real needs --yes-real and uses GROCY_URL from the secrets file.
#   --check is read only; exit 0 only when every field exists.
set -euo pipefail

TARGET=test
YES_REAL=0
MODE=create
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET=${2:-}; shift 2 ;;
    --yes-real) YES_REAL=1; shift ;;
    --check) MODE=check; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done

case "$TARGET" in
  test) ;;
  real) if [ "$YES_REAL" != 1 ]; then echo "--target real needs --yes-real" >&2; exit 2; fi ;;
  *) echo "--target must be test or real" >&2; exit 2 ;;
esac

if [ -z "${GROCY_SECRETS:-}" ] && [ "$(uname)" = Darwin ]; then
  GROCY_SECRETS=/Users/kbs/.config/grocy/credentials
fi
export GROCY_SECRETS
. "$(dirname "$0")/grocy-lib.sh"

TEST_HOST=grocy-test.audibox.cc
if [ "$TARGET" = test ]; then
  GROCY_API="https://$TEST_HOST/api"
fi
HOST=$(sed -E 's#^[a-z]+://([^/:]+).*#\1#' <<<"$GROCY_API")
if [ "$TARGET" = test ] && [ "$HOST" != "$TEST_HOST" ]; then
  echo "refusing host $HOST for --target test" >&2
  exit 2
fi
if [ "$TARGET" = real ] && [ "$HOST" = "$TEST_HOST" ]; then
  echo "--target real points at the test host, stopping" >&2
  exit 2
fi
echo "target $TARGET host $HOST mode $MODE"

# entity|name|grocy type|caption|column|preset values (comma separated)
USERFIELDS='chores|room|preset-list|Pièce|1|kitchen,bathroom,bedroom,living_room
chores|effort|number-integral|Effort|1|
chores|steps|text-multi-line|Étapes|0|
chores|tags|text-single-line|Étiquettes|1|
tasks|room|preset-list|Pièce|1|kitchen,bathroom,bedroom,living_room
tasks|effort|number-integral|Effort|0|
tasks|priority|preset-list|Priorité|1|urgent,high,normal,low
tasks|tags|text-single-line|Étiquettes|1|
tasks|planned|date|Prévu le|1|
tasks|steps|text-multi-line|Étapes|0|'

MISSING=0
FAILED=0

# The web pages living on a userentity (they hold no rows): Agenda (companion/agenda.js.html) and Dashboard
# (companion/dashboard.js.html).
for page in 'agenda|Agenda|fa-solid fa-list-check' 'dashboard|Tableau de bord|fa-solid fa-gauge'; do
  IFS='|' read -r ename ecaption eicon <<<"$page"
  if api GET /objects/userentities | jq -e --arg n "$ename" '.[] | select(.name == $n)' >/dev/null; then
    echo "userentity $ename exists"
  elif [ "$MODE" = check ]; then
    echo "userentity $ename missing"; MISSING=$((MISSING + 1))
  elif id=$(api POST /objects/userentities "$(jq -nc --arg n "$ename" --arg c "$ecaption" --arg i "$eicon" '{name:$n,caption:$c,show_in_sidebar_menu:1,icon_css_class:$i}')" | jq -r .created_object_id); then
    echo "userentity $ename created $id"
  else
    FAILED=$((FAILED + 1)); echo "userentity $ename failed"
  fi
done

prev_entity=""""
sort=0
while IFS='|' read -r entity name type caption column presets; do
  if [ "$entity" != "$prev_entity" ]; then sort=0; prev_entity=$entity; fi
  sort=$((sort + 1))
  rc=0
  userfield_ensure "$entity" "$name" "$type" "$caption" "$column" "$sort" "${presets//,/$'\n'}" "$MODE" || rc=$?
  case "$rc" in
    0) ;;
    1) MISSING=$((MISSING + 1)) ;;
    *) FAILED=$((FAILED + 1)); echo "$entity.$name failed" ;;
  esac
done <<<"$USERFIELDS"

echo "missing: $MISSING failed: $FAILED"
[ "$MISSING" = 0 ] && [ "$FAILED" = 0 ]
