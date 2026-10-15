#!/usr/bin/env node
'use strict';

/**
 * Sends an approved WhatsApp template through the ZapClaw API (Node.js 18 or
 * later, no dependencies). Unlike free-form messages, templates are not
 * bound to the 24-hour window.
 *
 *   ZAPCLAW_API_KEY=zc_live_... ZAPCLAW_FROM=15550001111 ZAPCLAW_TO=15550002222 \
 *   ZAPCLAW_TEMPLATE=order_update ZAPCLAW_TEMPLATE_LANGUAGE=en_US \
 *     node send/node/send-template.js "#1234"
 *
 * The template must be approved on the sending number, in that language.
 * GET /api/v1/send/templates lists the ones you can send. This example fills
 * a template whose body has one variable, {{1}}, with the first argument.
 *
 * Exit code: 0 sent, 2 delivery unknown, 1 refused or failed.
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
 * POST /api/v1/send/template
 * Body: { from, to, templateName, language?, components?, replyTo? }
 *
 * `components` uses Meta's template components format. `language` defaults
 * to pt_BR on the API, so always send the language your template was
 * approved in.
 */
const sendTemplate = async ({ apiKey, from, to, templateName, language, components, idempotencyKey }) => {
  const response = await fetch(`${BASE_URL}/api/v1/send/template`, {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ from, to, templateName, language, components }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

const main = async () => {
  const apiKey = requireEnv('ZAPCLAW_API_KEY');
  const from = requireEnv('ZAPCLAW_FROM');
  const to = requireEnv('ZAPCLAW_TO');
  const templateName = process.env.ZAPCLAW_TEMPLATE || 'order_update';
  const language = process.env.ZAPCLAW_TEMPLATE_LANGUAGE || 'en_US';
  const variable = process.argv[2] || '#1234';
  const idempotencyKey = process.env.ZAPCLAW_IDEMPOTENCY_KEY || randomUUID();

  const components = [
    { type: 'body', parameters: [{ type: 'text', text: variable }] },
  ];

  const { status, body } = await sendTemplate({
    apiKey, from, to, templateName, language, components, idempotencyKey,
  });

  if (status === 201) {
    console.log(`Sent. id=${body.message.id} wamid=${body.message.wamid} status=${body.message.status}`);
    return 0;
  }
  if (status === 202 && body && body.delivery === 'unknown') {
    console.warn(`Delivery unknown (${body.code}, meta_code ${body.meta_code}). ${body.warning}`);
    console.warn(`Idempotency-Key: ${idempotencyKey}`);
    return 2;
  }
  console.error(`Refused with HTTP ${status}: ${body && body.error ? body.error : JSON.stringify(body)}`);
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
