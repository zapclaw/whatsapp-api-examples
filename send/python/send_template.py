"""Send an approved WhatsApp template through the ZapClaw API.

Unlike free-form messages, templates are not bound to the 24-hour window.

    pip install -r send/python/requirements.txt
    ZAPCLAW_API_KEY=zc_live_... ZAPCLAW_FROM=15550001111 ZAPCLAW_TO=15550002222 \
    ZAPCLAW_TEMPLATE=order_update ZAPCLAW_TEMPLATE_LANGUAGE=en_US \
        python send/python/send_template.py "#1234"

The template must be approved on the sending number, in that language.
GET /api/v1/send/templates lists the ones you can send. This example fills a
template whose body has one variable, {{1}}, with the first argument.

Exit code: 0 sent, 2 delivery unknown, 1 refused or failed.
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


def send_template(api_key: str, sender: str, to: str, template_name: str, language: str,
                  components: list, idempotency_key: str) -> requests.Response:
    """POST /api/v1/send/template with body { from, to, templateName, language?, components?, replyTo? }.

    components uses Meta's template components format. language defaults to
    pt_BR on the API, so always send the language your template was approved in.
    """
    return requests.post(
        f"{BASE_URL}/api/v1/send/template",
        headers={"X-API-Key": api_key, "Idempotency-Key": idempotency_key},
        json={
            "from": sender,
            "to": to,
            "templateName": template_name,
            "language": language,
            "components": components,
        },
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
    template_name = os.environ.get("ZAPCLAW_TEMPLATE") or "order_update"
    language = os.environ.get("ZAPCLAW_TEMPLATE_LANGUAGE") or "en_US"
    variable = sys.argv[1] if len(sys.argv) > 1 else "#1234"
    idempotency_key = os.environ.get("ZAPCLAW_IDEMPOTENCY_KEY") or str(uuid.uuid4())

    components = [{"type": "body", "parameters": [{"type": "text", "text": variable}]}]

    try:
        response = send_template(api_key, sender, to, template_name, language, components, idempotency_key)
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
        print(f"Delivery unknown ({body.get('code')}, meta_code {body.get('meta_code')}). {body.get('warning')}",
              file=sys.stderr)
        print(f"Idempotency-Key: {idempotency_key}", file=sys.stderr)
        return 2

    print(f"Refused with HTTP {response.status_code}: {body.get('error', response.text)}", file=sys.stderr)
    if body.get("code"):
        print(f"code: {body['code']}", file=sys.stderr)
    print(f"Idempotency-Key: {idempotency_key}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    keep_output_safe()
    sys.exit(main())
