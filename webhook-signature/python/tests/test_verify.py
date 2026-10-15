import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from verify import verify_signature  # noqa: E402

FIXTURE_DIR = HERE.parent.parent / "fixture"
FIXTURE = json.loads((FIXTURE_DIR / "fixture.json").read_text(encoding="utf-8"))
BODY = (FIXTURE_DIR / FIXTURE["bodyFile"]).read_bytes()
SIGNATURE = FIXTURE["headers"]["X-ZapClaw-Signature"]
SECRET = FIXTURE["secret"]


def tampered_body() -> bytes:
    """The fixture body with one character of the message text changed."""
    at = BODY.index(b"Sunday")
    return BODY[:at] + b"M" + BODY[at + 1:]


class VerifySignatureTest(unittest.TestCase):
    def test_fixture_body_has_the_declared_size(self):
        self.assertEqual(len(BODY), FIXTURE["bodyBytes"])

    def test_accepts_the_fixture(self):
        self.assertTrue(verify_signature(BODY, SIGNATURE, SECRET))

    def test_accepts_a_bytearray(self):
        self.assertTrue(verify_signature(bytearray(BODY), SIGNATURE, SECRET))

    def test_rejects_a_body_with_one_byte_changed(self):
        self.assertFalse(verify_signature(tampered_body(), SIGNATURE, SECRET))

    def test_rejects_the_body_reserialized_by_python(self):
        # The classic mistake: verifying json.dumps(request.json) instead of
        # the raw bytes. Python's default spacing and ASCII escaping change
        # the bytes, so the signature cannot match.
        reserialized = json.dumps(json.loads(BODY)).encode("utf-8")
        self.assertNotEqual(reserialized, BODY)
        self.assertFalse(verify_signature(reserialized, SIGNATURE, SECRET))

    def test_rejects_a_trailing_newline(self):
        self.assertFalse(verify_signature(BODY + b"\n", SIGNATURE, SECRET))

    def test_rejects_a_different_secret(self):
        self.assertFalse(verify_signature(BODY, SIGNATURE, SECRET + "x"))
        self.assertFalse(verify_signature(BODY, SIGNATURE, ""))

    def test_rejects_missing_or_malformed_headers_without_raising(self):
        digest = SIGNATURE[len("sha256="):]
        for header in [
            None,
            "",
            "sha256=",
            digest,
            "sha1=" + digest,
            "SHA256=" + digest,
            "sha256=" + digest.upper(),
            SIGNATURE + " ",
            SIGNATURE[:-1],
            "sha256=" + "é" * 32,
        ]:
            with self.subTest(header=header):
                self.assertFalse(verify_signature(BODY, header, SECRET))

    def test_refuses_a_body_that_is_not_bytes(self):
        self.assertFalse(verify_signature(BODY.decode("utf-8"), SIGNATURE, SECRET))
        self.assertFalse(verify_signature(json.loads(BODY), SIGNATURE, SECRET))
        self.assertFalse(verify_signature(None, SIGNATURE, SECRET))


if __name__ == "__main__":
    unittest.main()
