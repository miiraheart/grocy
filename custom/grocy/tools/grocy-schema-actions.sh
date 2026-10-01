#!/usr/bin/env bash
# WP5 schema: the shared assistant history (docs/action-history.md), userentity gc_actions with its userfields. The web
# Activity page lives on it. Writes schema only, never a data row.
# Only GET and POST /objects/userfields and /objects/userentities. Adds what is missing, reports drift, never edits a field.
# Usage: grocy-schema-actions.sh [--target test|real] [--yes-real] [--check]
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
USERFIELDS='userentity-gc_actions|action_id|text-single-line|Identifiant|0|
userentity-gc_actions|created|text-single-line|Date|1|
userentity-gc_actions|kind|text-single-line|Type|1|
userentity-gc_actions|status|preset-list|Statut|1|applied,failed,undone,undoFailed,edited,superseded
userentity-gc_actions|origin|preset-list|Appareil|1|ios,web
userentity-gc_actions|source|text-single-line|Source|0|
userentity-gc_actions|session_id|text-single-line|Session|0|
userentity-gc_actions|parent_id|text-single-line|Action parente|0|
userentity-gc_actions|summary|text-single-line|Résumé|1|
userentity-gc_actions|sentence|text-single-line|Phrase|0|
userentity-gc_actions|record|text-multi-line|Détails|0|'

MISSING=0
FAILED=0

if api GET /objects/userentities | jq -e '.[] | select(.name == "gc_actions")' >/dev/null; then
  echo "userentity gc_actions exists"
elif [ "$MODE" = check ]; then
  echo "userentity gc_actions missing"; MISSING=$((MISSING + 1))
elif id=$(api POST /objects/userentities "$(jq -nc '{name:"gc_actions",caption:"Activité",show_in_sidebar_menu:1,icon_css_class:"fa-solid fa-clock-rotate-left"}')" | jq -r .created_object_id); then
  echo "userentity gc_actions created $id"
else
  FAILED=$((FAILED + 1)); echo "userentity gc_actions failed"
fi

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
