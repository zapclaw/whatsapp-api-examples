<?php

/**
 * Sends an approved WhatsApp template through the ZapClaw API (PHP 8.0 or
 * later with the curl extension). Unlike free-form messages, templates are
 * not bound to the 24-hour window.
 *
 *   ZAPCLAW_API_KEY=zc_live_... ZAPCLAW_FROM=15550001111 ZAPCLAW_TO=15550002222 \
 *   ZAPCLAW_TEMPLATE=order_update ZAPCLAW_TEMPLATE_LANGUAGE=en_US \
 *     php send/php/send-template.php "#1234"
 *
 * The template must be approved on the sending number, in that language.
 * GET /api/v1/send/templates lists the ones you can send. This example fills
 * a template whose body has one variable, {{1}}, with the first argument.
 *
 * Exit code: 0 sent, 2 delivery unknown, 1 refused or failed.
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
$templateName = getenv('ZAPCLAW_TEMPLATE') ?: 'order_update';
// The API defaults the language to pt_BR when it is omitted, so always send
// the language your template was approved in.
$language = getenv('ZAPCLAW_TEMPLATE_LANGUAGE') ?: 'en_US';
$variable = $argv[1] ?? '#1234';
$idempotencyKey = getenv('ZAPCLAW_IDEMPOTENCY_KEY') ?: bin2hex(random_bytes(16));

// POST /api/v1/send/template
// Body: { from, to, templateName, language?, components?, replyTo? }
// components uses Meta's template components format.
$payload = json_encode(
    [
        'from' => $from,
        'to' => $to,
        'templateName' => $templateName,
        'language' => $language,
        'components' => [
            ['type' => 'body', 'parameters' => [['type' => 'text', 'text' => $variable]]],
        ],
    ],
    JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR
);

$ch = curl_init($baseUrl . '/api/v1/send/template');
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
if (isset($body['code'])) {
    fwrite(STDERR, "code: {$body['code']}\n");
}
fwrite(STDERR, "Idempotency-Key: {$idempotencyKey}\n");
exit(1);
