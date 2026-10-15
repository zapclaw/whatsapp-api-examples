#!/usr/bin/env node
'use strict';

/**
 * Sends a WhatsApp text message through the ZapClaw API (Node.js 18 or later,
 * no dependencies).
 *
 *   ZAPCLAW_API_KEY=zc_live_... ZAPCLAW_FROM=15550001111 ZAPCLAW_TO=15550002222 \
 *     node send/node/send-text.js "Hello from the ZapClaw API"
 *
 * ZAPCLAW_FROM is one of your connected numbers and ZAPCLAW_TO the recipient,
 * both in E.164 digits. A free-form text only reaches a contact who has
 * written to you in the last 24 hours; outside that window, send a template.
 *
 * Exit code: 0 sent, 2 delivery unknown (see below), 1 refused or failed.
 */

const { randomUUID } = require('node:crypto');

const BASE_URL = (process.env.ZAPCLAW_BASE_URL || 'https://api.zapclaw.app').replace(/\/+$/, '');

const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`Set ${name} first. See the README.`);
    process.exit(1);
  }
  return value;
};

/**
 * POST /api/v1/send/text
 * Body: { from, to, text, previewUrl?, replyTo? }
 */
const sendText = async ({ apiKey, from, to, text, idempotencyKey }) => {
  const response = await fetch(`${BASE_URL}/api/v1/send/text`, {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
      // Identifies this send, not this attempt: a retry with the same key
      // inside 10 minutes returns the first answer instead of a second message.
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ from, to, text }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

const main = async () => {
  const apiKey = requireEnv('ZAPCLAW_API_KEY');
  const from = requireEnv('ZAPCLAW_FROM');
  const to = requireEnv('ZAPCLAW_TO');
  const text = process.argv[2] || 'Hello from the ZapClaw API';
  // Reuse the key printed below (ZAPCLAW_IDEMPOTENCY_KEY=...) to retry this
  // exact send safely.
  const idempotencyKey = process.env.ZAPCLAW_IDEMPOTENCY_KEY || randomUUID();

  const { status, body } = await sendText({ apiKey, from, to, text, idempotencyKey });

  if (status === 201) {
    console.log(`Sent. id=${body.message.id} wamid=${body.message.wamid} status=${body.message.status}`);
    return 0;
  }
  if (status === 202 && body && body.delivery === 'unknown') {
    // Meta reported a failure that does not rule out delivery: the message may
    // be on the phone already. Do not resend with a new key. Repeat only with
    // this same Idempotency-Key, which cannot become a second message.
    console.warn(`Delivery unknown (${body.code}, meta_code ${body.meta_code}). ${body.warning}`);
    console.warn(`Idempotency-Key: ${idempotencyKey}`);
    return 2;
  }
  console.error(`Refused with HTTP ${status}: ${body && body.error ? body.error : JSON.stringify(body)}`);
  if (body && body.meta_code === 131047) {
    console.error('The 24-hour window with this contact is closed: send a template instead (send-template.js).');
  }
  if (body && body.code) console.error(`code: ${body.code}`);
  console.error(`Idempotency-Key: ${idempotencyKey}`);
  return 1;
};

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`Request failed: ${error.message}`);
    process.exit(1);
  },
);
