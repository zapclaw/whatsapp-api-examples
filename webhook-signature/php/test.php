<?php

/**
 * Checks zapclaw_verify_signature() against the shared fixture.
 *
 *   php webhook-signature/php/test.php
 *
 * Exits 0 when every check passes, 1 otherwise.
 */

declare(strict_types=1);

require __DIR__ . '/verify.php';

$fixtureDir = __DIR__ . '/../fixture';
$fixture = json_decode((string) file_get_contents($fixtureDir . '/fixture.json'), true, 512, JSON_THROW_ON_ERROR);
$body = (string) file_get_contents($fixtureDir . '/' . $fixture['bodyFile']);
$signature = $fixture['headers']['X-ZapClaw-Signature'];
$secret = $fixture['secret'];

$failures = 0;
$check = static function (string $name, bool $passed) use (&$failures): void {
    echo ($passed ? 'ok   ' : 'FAIL ') . $name . PHP_EOL;
    if (!$passed) {
        $failures++;
    }
};

$at = strpos($body, 'Sunday');
$tampered = substr_replace($body, 'M', (int) $at, 1);
$digest = substr($signature, strlen('sha256='));

$check('the fixture body has the declared size', strlen($body) === $fixture['bodyBytes']);
$check('accepts the fixture', zapclaw_verify_signature($body, $signature, $secret));
$check('rejects a body with one byte changed', $at !== false && !zapclaw_verify_signature($tampered, $signature, $secret));
$reencoded = json_encode(json_decode($body, true, 512, JSON_THROW_ON_ERROR), JSON_THROW_ON_ERROR);
$check('rejects the body re-encoded by json_encode', $reencoded !== $body && !zapclaw_verify_signature($reencoded, $signature, $secret));
$check('rejects a trailing newline', !zapclaw_verify_signature($body . "\n", $signature, $secret));
$check('rejects a different secret', !zapclaw_verify_signature($body, $signature, $secret . 'x'));
$check('rejects an empty secret', !zapclaw_verify_signature($body, $signature, ''));

$badHeaders = [
    'missing' => null,
    'empty' => '',
    'prefix only' => 'sha256=',
    'no prefix' => $digest,
    'sha1 prefix' => 'sha1=' . $digest,
    'uppercase prefix' => 'SHA256=' . $digest,
    'uppercase hex' => 'sha256=' . strtoupper($digest),
    'trailing space' => $signature . ' ',
    'one character short' => substr($signature, 0, -1),
];
foreach ($badHeaders as $label => $header) {
    $check("rejects a header that is {$label}", !zapclaw_verify_signature($body, $header, $secret));
}

echo PHP_EOL . ($failures === 0 ? 'All checks passed.' : "{$failures} check(s) failed.") . PHP_EOL;
exit($failures === 0 ? 0 : 1);
