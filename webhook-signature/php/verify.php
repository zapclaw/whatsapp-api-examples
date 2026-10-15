<?php

declare(strict_types=1);

/**
 * Checks the X-ZapClaw-Signature header of a ZapClaw webhook request.
 *
 * ZapClaw signs every webhook with HMAC-SHA256 over the raw request body,
 * keyed with your webhook signing secret, and sends the lowercase hex digest
 * prefixed with "sha256=". Compute the same value over the exact bytes you
 * received (file_get_contents('php://input')) and compare in constant time.
 *
 * Never verify json_encode(json_decode($body)): re-encoding changes the bytes
 * (escaped slashes and Unicode, spacing), so the signature cannot match.
 *
 * @param string      $rawBody         the request body exactly as received
 * @param string|null $signatureHeader the X-ZapClaw-Signature header value, or null if absent
 * @param string      $secret          your webhook signing secret (whsec_...), used as is
 */
function zapclaw_verify_signature(string $rawBody, ?string $signatureHeader, string $secret): bool
{
    if ($signatureHeader === null || $signatureHeader === '' || $secret === '') {
        return false;
    }
    $expected = 'sha256=' . hash_hmac('sha256', $rawBody, $secret);

    // hash_equals compares in constant time. The known value goes first.
    return hash_equals($expected, $signatureHeader);
}
