"""Send a WhatsApp text message through the ZapClaw API.

    pip install -r send/python/requirements.txt
    ZAPCLAW_API_KEY=zc_live_... ZAPCLAW_FROM=15550001111 ZAPCLAW_TO=15550002222 \
        python send/python/send_text.py "Hello from the ZapClaw API"

ZAPCLAW_FROM is one of your connected numbers and ZAPCLAW_TO the recipient,
both in E.164 digits. A free-form text only reaches a contact who has written
to you in the last 24 hours; outside that window, send a template.

Exit code: 0 sent, 2 delivery unknown (see below), 1 refused or failed.
"""

import os
import sys
import uuid

import requests

BASE_URL = os.environ.get("ZAPCLAW_BASE_URL", "https://api.zapclaw.app").rstrip("/")


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        sys.exit(f"Set {name} first. See the README.")
    return value


def send_text(api_key: str, sender: str, to: str, text: str, idempotency_key: str) -> requests.Response:
    """POST /api/v1/send/text with body { from, to, text, previewUrl?, replyTo? }."""
    return requests.post(
        f"{BASE_URL}/api/v1/send/text",
        headers={
            "X-API-Key": api_key,
            # Identifies this send, not this attempt: a retry with the same key
            # inside 10 minutes returns the first answer instead of a second message.
            "Idempotency-Key": idempotency_key,
        },
        json={"from": sender, "to": to, "text": text},  # json= also sets Content-Type
        timeout=30,
    )


def keep_output_safe() -> None:
    """Printing a character the console cannot encode must never crash the script."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="backslashreplace")


def main() -> int:
    api_key = require_env("ZAPCLAW_API_KEY")
    sender = require_env("ZAPCLAW_FROM")
    to = require_env("ZAPCLAW_TO")
    text = sys.argv[1] if len(sys.argv) > 1 else "Hello from the ZapClaw API"
    # Reuse the key printed below (ZAPCLAW_IDEMPOTENCY_KEY=...) to retry this exact send safely.
    idempotency_key = os.environ.get("ZAPCLAW_IDEMPOTENCY_KEY") or str(uuid.uuid4())

    try:
        response = send_text(api_key, sender, to, text, idempotency_key)
    except requests.RequestException as error:
        print(f"Request failed: {error}", file=sys.stderr)
        return 1

    try:
        body = response.json()
    except ValueError:
        body = {}

    if response.status_code == 201:
        message = body["message"]
        print(f"Sent. id={message['id']} wamid={message['wamid']} status={message['status']}")
        return 0
    if response.status_code == 202 and body.get("delivery") == "unknown":
        # Meta reported a failure that does not rule out delivery: the message
        # may be on the phone already. Do not resend with a new key. Repeat only
        # with this same Idempotency-Key, which cannot become a second message.
        print(f"Delivery unknown ({body.get('code')}, meta_code {body.get('meta_code')}). {body.get('warning')}",
              file=sys.stderr)
        print(f"Idempotency-Key: {idempotency_key}", file=sys.stderr)
        return 2

    print(f"Refused with HTTP {response.status_code}: {body.get('error', response.text)}", file=sys.stderr)
    if body.get("meta_code") == 131047:
        print("The 24-hour window with this contact is closed: send a template instead (send_template.py).",
              file=sys.stderr)
    if body.get("code"):
        print(f"code: {body['code']}", file=sys.stderr)
    print(f"Idempotency-Key: {idempotency_key}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    keep_output_safe()
    sys.exit(main())
