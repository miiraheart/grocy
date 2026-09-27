#!/usr/bin/env bash
# Deploy an n8n workflow template to audibox.
# Templates live in n8n/templates/*.json with placeholders; secrets are filled on the server only.
# Usage: ./deploy-workflow.sh templates/shelf-life.json [--activate]
set -euo pipefail

TEMPLATE="${1:?template path}"
ACTIVATE="${2:-}"
HOST="audibox"
REMOTE_DIR="/home/miira/apps/docker/n8n-templates"
NAME="$(basename "$TEMPLATE")"

scp -q "$TEMPLATE" "$HOST:/tmp/$NAME.template"
ssh "$HOST" bash -s -- "$NAME" "$ACTIVATE" <<'REMOTE'
set -euo pipefail
NAME="$1"; ACTIVATE="${2:-}"
mkdir -p /home/miira/apps/docker/n8n-templates
set -a; . /home/miira/apps/docker/grocy/grocy.secrets; set +a
SECRET_FILE=/home/miira/apps/docker/n8n-templates/webhook.secret
if [ ! -s "$SECRET_FILE" ]; then head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$SECRET_FILE"; chmod 600 "$SECRET_FILE"; fi
WEBHOOK_SECRET=$(cat "$SECRET_FILE")
KEYS_FILE=/home/miira/apps/docker/n8n-templates/keys.conf
key() { [ -f "$KEYS_FILE" ] && sed -n "s/^$1=//p" "$KEYS_FILE" | tail -1 | tr -d "\r\"'" || true; }
GROQ_API_KEY=$(key GROQ_API_KEY)
MISTRAL_API_KEY=$(key MISTRAL_API_KEY)
GEMINI_API_KEY=$(key GEMINI_API_KEY)
TIKTOK_SECRET=$(key TIKTOK_SECRET)
if grep -q __TIKTOK_SECRET__ "/tmp/$NAME.template" && [ -z "$TIKTOK_SECRET" ]; then echo "TIKTOK_SECRET missing in $KEYS_FILE" >&2; exit 1; fi
OUT="/home/miira/apps/docker/n8n-templates/$NAME"
sed -e "s|__GROCY_API_KEY__|$GROCY_API_KEY|g" \
    -e "s|__WEBHOOK_SECRET__|$WEBHOOK_SECRET|g" \
    -e "s|__GROQ_API_KEY__|${GROQ_API_KEY:-}|g" \
    -e "s|__MISTRAL_API_KEY__|${MISTRAL_API_KEY:-}|g" \
    -e "s|__GEMINI_API_KEY__|${GEMINI_API_KEY:-}|g" \
    -e "s|__TIKTOK_SECRET__|${TIKTOK_SECRET:-}|g" \
    "/tmp/$NAME.template" > "$OUT"
chmod 600 "$OUT"
COMPANION=/home/miira/apps/docker/grocy/config/data/companion.json
printf '{"webhook_base":"https://n8n.audibox.cc/webhook","secret":"%s"}\n' "$WEBHOOK_SECRET" > "$COMPANION"
chmod 640 "$COMPANION"
docker cp "$OUT" "n8n:/tmp/$NAME"
docker exec n8n n8n import:workflow --input="/tmp/$NAME"
docker exec n8n sh -c ": > /tmp/$NAME"
if [ "$ACTIVATE" = "--activate" ]; then
  WF_ID=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print((d[0] if isinstance(d, list) else d)["id"])' "$OUT")
  docker exec n8n n8n publish:workflow --id="$WF_ID"
fi
echo "imported $NAME (webhook secret in $SECRET_FILE)"
REMOTE
echo "Restart n8n to activate webhooks: ssh audibox docker restart n8n"
