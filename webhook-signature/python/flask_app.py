"""A minimal Flask endpoint that receives ZapClaw webhooks and rejects any
request whose X-ZapClaw-Signature does not match.

    pip install -r webhook-signature/python/requirements.txt
    ZAPCLAW_WEBHOOK_SECRET=whsec_... python webhook-signature/python/flask_app.py

It listens on http://localhost:3000/webhooks/zapclaw (PORT changes the port).
ZapClaw only calls public https URLs, so put a reverse proxy or a tunnel you
control in front of it to receive real events.
"""

import json
import os
import sys
from typing import Callable, Optional

from flask import Flask, abort, request

from verify import verify_signature

EventHandler = Callable[[dict, dict], None]


def log_event(event: dict, meta: dict) -> None:
    """Default handler: prints one line per event. Replace it with your own."""
    replay = f" (replay of {meta['redelivery_of']})" if meta["redelivery_of"] else ""
    data = event.get("data") or {}
    if meta["event_type"] == "message.received" and data.get("type") == "text":
        print(f"[{meta['delivery_id']}]{replay} text from {data.get('user_id')}: {data['text']['body']}", flush=True)
    else:
        print(f"[{meta['delivery_id']}]{replay} {meta['event_type']}", flush=True)


def create_app(secret: Optional[str] = None, on_event: EventHandler = log_event) -> Flask:
    secret = secret or os.environ.get("ZAPCLAW_WEBHOOK_SECRET")
    if not secret:
        raise RuntimeError(
            "Set ZAPCLAW_WEBHOOK_SECRET to the signing secret shown on the Webhook page of the dashboard."
        )

    app = Flask(__name__)

    @app.post("/webhooks/zapclaw")
    def zapclaw_webhook():
        # get_data() returns the body bytes exactly as received. Read it before
        # anything touches request.json or request.form.
        raw_body = request.get_data()
        if not verify_signature(raw_body, request.headers.get("X-ZapClaw-Signature"), secret):
            abort(401)

        try:
            event = json.loads(raw_body)
        except ValueError:
            abort(400)

        # ZapClaw waits 10 seconds for a 2xx and retries otherwise. Keep this
        # handler fast: hand slow work (a database, an AI model, another API)
        # to a queue or a background worker.
        on_event(
            event,
            {
                "event_type": request.headers.get("X-ZapClaw-Event"),
                "delivery_id": request.headers.get("X-ZapClaw-Delivery"),
                # Present only on a replay you asked for from the dashboard.
                # Process it even if you have already seen its message_id.
                "redelivery_of": request.headers.get("X-ZapClaw-Redelivery"),
            },
        )
        return {"received": True}, 200

    return app


def keep_output_safe() -> None:
    """Printing a character the console cannot encode must never crash the script."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="backslashreplace")


if __name__ == "__main__":
    # Message text can hold any character, emoji included: printing it must not
    # turn a verified delivery into a 500 (and a retry) on a non-UTF-8 console.
    keep_output_safe()
    create_app().run(port=int(os.environ.get("PORT", "3000")))
