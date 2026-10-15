import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

try:
    import flask  # noqa: F401
except ImportError:  # pragma: no cover
    flask = None

FIXTURE_DIR = HERE.parent.parent / "fixture"
FIXTURE = json.loads((FIXTURE_DIR / "fixture.json").read_text(encoding="utf-8"))
BODY = (FIXTURE_DIR / FIXTURE["bodyFile"]).read_bytes()
HEADERS = FIXTURE["headers"]


@unittest.skipIf(flask is None, "Flask is not installed: pip install -r webhook-signature/python/requirements.txt")
class FlaskEndpointTest(unittest.TestCase):
    def setUp(self):
        from flask_app import create_app

        self.received = []
        app = create_app(FIXTURE["secret"], on_event=lambda event, meta: self.received.append((event, meta)))
        self.client = app.test_client()

    def post(self, body, headers=None):
        return self.client.post("/webhooks/zapclaw", data=body, headers=headers or HEADERS)

    def test_accepts_the_fixture_and_hands_over_the_event(self):
        response = self.post(BODY)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.received), 1)
        event, meta = self.received[0]
        self.assertEqual(event["data"]["text"]["body"], "Hi! Is the café open on Sunday? 👋")
        self.assertEqual(meta["event_type"], "message.received")
        self.assertEqual(meta["delivery_id"], HEADERS["X-ZapClaw-Delivery"])
        self.assertIsNone(meta["redelivery_of"])

    def test_rejects_a_tampered_body(self):
        at = BODY.index(b"Sunday")
        response = self.post(BODY[:at] + b"M" + BODY[at + 1:])
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.received, [])

    def test_rejects_a_missing_signature(self):
        headers = {k: v for k, v in HEADERS.items() if k != "X-ZapClaw-Signature"}
        response = self.post(BODY, headers)
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.received, [])

    def test_passes_the_redelivery_header_through(self):
        original = "0b9a3c1e-2f4d-4e6a-8b7c-9d0e1f2a3b4c"
        response = self.post(BODY, {**HEADERS, "X-ZapClaw-Redelivery": original})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.received[0][1]["redelivery_of"], original)


if __name__ == "__main__":
    unittest.main()
