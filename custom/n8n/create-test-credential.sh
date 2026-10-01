#!/usr/bin/env bash
# Creates the n8n credential "OpenRouter test" (id orTestKey0000001) used by every test twin.
# The key comes from OPENROUTER_TEST_KEY in ~/.config/grocy/credentials; it never appears on a command line or in a log.
# Usage: ./create-test-credential.sh   (then: ssh audibox docker restart n8n)
set -euo pipefail
CREDS="$HOME/.config/grocy/credentials"
HOST="audibox"
KEY="$(sed -n 's/^OPENROUTER_TEST_KEY=//p' "$CREDS" | tail -1 | tr -d "\"' \r")"
if [ -z "$KEY" ]; then echo "OPENROUTER_TEST_KEY missing from $CREDS" >&2; exit 1; fi
python3 -c 'import json,sys; print(json.dumps([{"id":"orTestKey0000001","name":"OpenRouter test","type":"openRouterApi","data":{"apiKey":sys.stdin.read().strip()}}]))' <<<"$KEY" |
ssh "$HOST" bash -c "'set -euo pipefail
F=\$(mktemp /tmp/or-test-cred.XXXXXX); chmod 600 \$F; cat > \$F
docker cp \$F n8n:/tmp/or-test-cred.json; rm -f \$F
docker exec n8n n8n import:credentials --input=/tmp/or-test-cred.json
docker exec n8n rm -f /tmp/or-test-cred.json
echo imported credential orTestKey0000001'"
