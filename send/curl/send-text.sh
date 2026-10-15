#!/usr/bin/env bash
# Sends a WhatsApp text message through the ZapClaw API with curl.
#
#   export ZAPCLAW_API_KEY=zc_live_...
#   export ZAPCLAW_FROM=15550001111   # one of your connected numbers, E.164 digits
#   export ZAPCLAW_TO=15550002222     # the recipient
#   bash send/curl/send-text.sh "Hello from the ZapClaw API"
#
# A free-form text only reaches a contact who has written to you in the last
# 24 hours; outside that window, send a template (send-template.sh).
#
# Exit code: 0 sent, 2 delivery unknown (see the README), 1 refused or failed.

set -euo pipefail

: "${ZAPCLAW_API_KEY:?Set ZAPCLAW_API_KEY first. See the README.}"
: "${ZAPCLAW_FROM:?Set ZAPCLAW_FROM first. See the README.}"
: "${ZAPCLAW_TO:?Set ZAPCLAW_TO first. See the README.}"
BASE_URL="${ZAPCLAW_BASE_URL:-https://api.zapclaw.app}"
BASE_URL="${BASE_URL%/}"
TEXT="${1:-Hello from the ZapClaw API}"
# Identifies this send, not this attempt. To retry the same send safely, run
# again with ZAPCLAW_IDEMPOTENCY_KEY set to the key printed below.
IDEMPOTENCY_KEY="${ZAPCLAW_IDEMPOTENCY_KEY:-text-$(date +%s)-$RANDOM$RANDOM}"

# Numbers go into the JSON as they are, so accept only characters that need
# no escaping: digits, letters, dots and a leading plus.
for value in "$ZAPCLAW_FROM" "$ZAPCLAW_TO"; do
  if [[ ! "$value" =~ ^\+?[0-9A-Za-z.]+$ ]]; then
    echo "Not a phone number or user id: $value" >&2
    exit 1
  fi
done

# Escapes the characters JSON requires inside a string.
json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

body=$(printf '{"from":"%s","to":"%s","text":"%s"}' \
  "$ZAPCLAW_FROM" "$ZAPCLAW_TO" "$(json_escape "$TEXT")")

response_file=$(mktemp)
trap 'rm -f "$response_file"' EXIT

# The body goes through stdin, not the command line, so non-ASCII text
# reaches curl unchanged everywhere: a native Windows curl.exe can read its
# arguments in the system code page and mangle accents and emoji.
status=$(printf '%s' "$body" | curl -sS --max-time 30 -o "$response_file" -w '%{http_code}' \
  -X POST "$BASE_URL/api/v1/send/text" \
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
    # Meta reported a failure that does not rule out delivery. Do not resend
    # with a new key; repeat only with this same Idempotency-Key.
    echo "Delivery unknown. Idempotency-Key: $IDEMPOTENCY_KEY" >&2
    exit 2
    ;;
  *)
    echo "Refused with HTTP $status. Idempotency-Key: $IDEMPOTENCY_KEY" >&2
    exit 1
    ;;
esac
