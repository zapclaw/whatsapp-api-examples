#!/usr/bin/env bash
# Sends an approved WhatsApp template through the ZapClaw API with curl.
# Unlike free-form messages, templates are not bound to the 24-hour window.
#
#   export ZAPCLAW_API_KEY=zc_live_...
#   export ZAPCLAW_FROM=15550001111            # one of your connected numbers, E.164 digits
#   export ZAPCLAW_TO=15550002222              # the recipient
#   export ZAPCLAW_TEMPLATE=order_update       # an approved template on that number
#   export ZAPCLAW_TEMPLATE_LANGUAGE=en_US     # the language it was approved in
#   bash send/curl/send-template.sh "#1234"
#
# This example fills a template whose body has one variable, {{1}}, with the
# first argument. The API defaults the language to pt_BR when it is omitted,
# so it is always sent here.
#
# Exit code: 0 sent, 2 delivery unknown (see the README), 1 refused or failed.

set -euo pipefail

: "${ZAPCLAW_API_KEY:?Set ZAPCLAW_API_KEY first. See the README.}"
: "${ZAPCLAW_FROM:?Set ZAPCLAW_FROM first. See the README.}"
: "${ZAPCLAW_TO:?Set ZAPCLAW_TO first. See the README.}"
BASE_URL="${ZAPCLAW_BASE_URL:-https://api.zapclaw.app}"
BASE_URL="${BASE_URL%/}"
TEMPLATE="${ZAPCLAW_TEMPLATE:-order_update}"
LANGUAGE="${ZAPCLAW_TEMPLATE_LANGUAGE:-en_US}"
VARIABLE="${1:-#1234}"
IDEMPOTENCY_KEY="${ZAPCLAW_IDEMPOTENCY_KEY:-template-$(date +%s)-$RANDOM$RANDOM}"

for value in "$ZAPCLAW_FROM" "$ZAPCLAW_TO"; do
  if [[ ! "$value" =~ ^\+?[0-9A-Za-z.]+$ ]]; then
    echo "Not a phone number or user id: $value" >&2
    exit 1
  fi
done
if [[ ! "$TEMPLATE" =~ ^[a-z0-9_]+$ ]]; then
  echo "Template names are lowercase letters, digits and underscores: $TEMPLATE" >&2
  exit 1
fi
if [[ ! "$LANGUAGE" =~ ^[A-Za-z_]+$ ]]; then
  echo "Not a language code: $LANGUAGE" >&2
  exit 1
fi

json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

body=$(printf '{"from":"%s","to":"%s","templateName":"%s","language":"%s","components":[{"type":"body","parameters":[{"type":"text","text":"%s"}]}]}' \
  "$ZAPCLAW_FROM" "$ZAPCLAW_TO" "$TEMPLATE" "$LANGUAGE" "$(json_escape "$VARIABLE")")

response_file=$(mktemp)
trap 'rm -f "$response_file"' EXIT

# The body goes through stdin, not the command line, so non-ASCII text
# reaches curl unchanged everywhere: a native Windows curl.exe can read its
# arguments in the system code page and mangle accents and emoji.
status=$(printf '%s' "$body" | curl -sS --max-time 30 -o "$response_file" -w '%{http_code}' \
  -X POST "$BASE_URL/api/v1/send/template" \
  -H "X-API-Key: $ZAPCLAW_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  --data-binary @-) || { echo "Request failed: curl could not complete the call." >&2; exit 1; }

cat "$response_file"
echo

case "$status" in
  201)
    exit 0
    ;;
  202)
    echo "Delivery unknown. Idempotency-Key: $IDEMPOTENCY_KEY" >&2
    exit 2
    ;;
  *)
    echo "Refused with HTTP $status. Idempotency-Key: $IDEMPOTENCY_KEY" >&2
    exit 1
    ;;
esac
