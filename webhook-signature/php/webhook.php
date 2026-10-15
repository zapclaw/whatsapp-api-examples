<?php

/**
 * A minimal PHP endpoint that receives ZapClaw webhooks and rejects any
 * request whose X-ZapClaw-Signature does not match.
 *
 *   ZAPCLAW_WEBHOOK_SECRET=whsec_... php -S localhost:3000 webhook-signature/php/webhook.php
 *
 * Under Apache or nginx with PHP-FPM, set ZAPCLAW_WEBHOOK_SECRET in the server
 * environment and point your webhook route at this file. ZapClaw only calls
 * public https URLs, so put a reverse proxy or a tunnel you control in front
 * of a local server to receive real events.
 */

declare(strict_types=1);

require __DIR__ . '/verify.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    exit;
}

$secret = getenv('ZAPCLAW_WEBHOOK_SECRET') ?: '';
if ($secret === '') {
    error_log('Set ZAPCLAW_WEBHOOK_SECRET to the signing secret shown on the Webhook page of the dashboard.');
    http_response_code(500);
    exit;
}

// The body exactly as received. In Laravel this is $request->getContent(),
// in Symfony $request->getContent(): never the decoded JSON.
$rawBody = file_get_contents('php://input');
$signature = $_SERVER['HTTP_X_ZAPCLAW_SIGNATURE'] ?? null;

if (!is_string($rawBody) || !zapclaw_verify_signature($rawBody, $signature, $secret)) {
    http_response_code(401);
    header('Content-Type: application/json');
    echo '{"error":"invalid signature"}';
    exit;
}

try {
    $event = json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR);
} catch (JsonException $e) {
    http_response_code(400);
    exit;
}

$eventType = $_SERVER['HTTP_X_ZAPCLAW_EVENT'] ?? '';
$deliveryId = $_SERVER['HTTP_X_ZAPCLAW_DELIVERY'] ?? '';
// Present only on a replay you asked for from the dashboard. Process it even
// if you have already seen its message_id.
$redeliveryOf = $_SERVER['HTTP_X_ZAPCLAW_REDELIVERY'] ?? null;

// ZapClaw waits 10 seconds for a 2xx and retries otherwise. Keep this fast:
// queue slow work (a database, an AI model, another API) instead of doing it here.
if ($eventType === 'message.received' && ($event['data']['type'] ?? null) === 'text') {
    error_log(sprintf(
        '[%s]%s text from %s: %s',
        $deliveryId,
        $redeliveryOf !== null ? " (replay of {$redeliveryOf})" : '',
        (string) ($event['data']['user_id'] ?? ''),
        (string) ($event['data']['text']['body'] ?? '')
    ));
} else {
    error_log(sprintf('[%s] %s', $deliveryId, $eventType));
}

http_response_code(200);
header('Content-Type: application/json');
echo '{"received":true}';
