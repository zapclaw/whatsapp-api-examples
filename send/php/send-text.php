<?php

/**
 * Sends a WhatsApp text message through the ZapClaw API (PHP 8.0 or later
 * with the curl extension).
 *
 *   ZAPCLAW_API_KEY=zc_live_... ZAPCLAW_FROM=15550001111 ZAPCLAW_TO=15550002222 \
 *     php send/php/send-text.php "Hello from the ZapClaw API"
 *
 * ZAPCLAW_FROM is one of your connected numbers and ZAPCLAW_TO the recipient,
 * both in E.164 digits. A free-form text only reaches a contact who has
 * written to you in the last 24 hours; outside that window, send a template.
 *
 * Exit code: 0 sent, 2 delivery unknown (see below), 1 refused or failed.
 */

declare(strict_types=1);

function require_env(string $name): string
{
    $value = getenv($name);
    if ($value === false || $value === '') {
        fwrite(STDERR, "Set {$name} first. See the README.\n");
        exit(1);
    }
    return $value;
}

$baseUrl = rtrim(getenv('ZAPCLAW_BASE_URL') ?: 'https://api.zapclaw.app', '/');
$apiKey = require_env('ZAPCLAW_API_KEY');
$from = require_env('ZAPCLAW_FROM');
$to = require_env('ZAPCLAW_TO');
$text = $argv[1] ?? 'Hello from the ZapClaw API';
// Identifies this send, not this attempt: a retry with the same key inside
// 10 minutes returns the first answer instead of a second message. Reuse the
// key printed below (ZAPCLAW_IDEMPOTENCY_KEY=...) to retry this exact send.
$idempotencyKey = getenv('ZAPCLAW_IDEMPOTENCY_KEY') ?: bin2hex(random_bytes(16));

// POST /api/v1/send/text
// Body: { from, to, text, previewUrl?, replyTo? }
$payload = json_encode(
    ['from' => $from, 'to' => $to, 'text' => $text],
    JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR
);

$ch = curl_init($baseUrl . '/api/v1/send/text');
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => [
        'X-API-Key: ' . $apiKey,
        'Content-Type: application/json',
        'Idempotency-Key: ' . $idempotencyKey,
    ],
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_TIMEOUT => 30,
]);
$responseBody = curl_exec($ch);
if ($responseBody === false) {
    fwrite(STDERR, 'Request failed: ' . curl_error($ch) . "\n");
    exit(1);
}
$status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
$body = json_decode((string) $responseBody, true);
if (!is_array($body)) {
    $body = [];
}

if ($status === 201) {
    $message = $body['message'];
    echo "Sent. id={$message['id']} wamid={$message['wamid']} status={$message['status']}\n";
    exit(0);
}
if ($status === 202 && ($body['delivery'] ?? null) === 'unknown') {
    // Meta reported a failure that does not rule out delivery: the message may
    // be on the phone already. Do not resend with a new key. Repeat only with
    // this same Idempotency-Key, which cannot become a second message.
    fwrite(STDERR, sprintf(
        "Delivery unknown (%s, meta_code %s). %s\n",
        $body['code'] ?? '',
        $body['meta_code'] ?? '',
        $body['warning'] ?? ''
    ));
    fwrite(STDERR, "Idempotency-Key: {$idempotencyKey}\n");
    exit(2);
}

fwrite(STDERR, "Refused with HTTP {$status}: " . ($body['error'] ?? (string) $responseBody) . "\n");
if (($body['meta_code'] ?? null) === 131047) {
    fwrite(STDERR, "The 24-hour window with this contact is closed: send a template instead (send-template.php).\n");
}
if (isset($body['code'])) {
    fwrite(STDERR, "code: {$body['code']}\n");
}
fwrite(STDERR, "Idempotency-Key: {$idempotencyKey}\n");
exit(1);
