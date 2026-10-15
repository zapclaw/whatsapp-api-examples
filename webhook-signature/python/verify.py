"""Verify the X-ZapClaw-Signature header of a ZapClaw webhook request.

Standard library only, so it works with any framework: pass the raw request
body as bytes, the header value, and your webhook signing secret.

ZapClaw signs every webhook with HMAC-SHA256 over the raw request body, keyed
with the signing secret, and sends the lowercase hex digest prefixed with
"sha256=". Compute the same value over the exact bytes you received and
compare in constant time.

Never verify json.dumps(request.json): Python serializes with other spacing,
escapes non-ASCII characters by default and may reorder keys, so those bytes
are not the bytes ZapClaw signed.
"""

import hashlib
import hmac
from typing import Optional


def verify_signature(raw_body: bytes, signature_header: Optional[str], secret: str) -> bool:
    """Return True only when signature_header is the signature of raw_body.

    raw_body: the request body exactly as received, as bytes.
    signature_header: the X-ZapClaw-Signature header value, or None if absent.
    secret: your webhook signing secret (whsec_...), used as is.
    """
    if not isinstance(raw_body, (bytes, bytearray)) or not signature_header or not secret:
        return False
    digest = hmac.new(secret.encode("utf-8"), bytes(raw_body), hashlib.sha256).hexdigest()
    expected = ("sha256=" + digest).encode("ascii")
    # compare_digest runs in constant time and returns False on a length
    # mismatch. Both sides are bytes, so a non-ASCII header cannot raise.
    return hmac.compare_digest(expected, signature_header.encode("utf-8"))
