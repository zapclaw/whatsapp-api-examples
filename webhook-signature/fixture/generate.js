#!/usr/bin/env node
'use strict';

/**
 * Generates the shared webhook fixture: a message.received body exactly as
 * ZapClaw would send it, a test signing secret, and the X-ZapClaw-Signature
 * header ZapClaw would compute for that body and secret.
 *
 *   node webhook-signature/fixture/generate.js           writes payload.json and fixture.json
 *   node webhook-signature/fixture/generate.js --check   exits 1 if the files on disk differ
 *
 * The signature is computed the way ZapClaw computes it:
 *
 *   body      = JSON.stringify(payload)   compact JSON, UTF-8, no trailing newline
 *   signature = "sha256=" + lowercase hex of HMAC-SHA256(key: secret, message: body)
 *
 * The secret is used as given (its UTF-8 bytes, prefix included), never
 * base64-decoded. Reference:
 * https://zapclaw.app/docs.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples#webhook-signature
 *
 * Everything here is a test value: the secret signs nothing real, and the
 * phone numbers and ids are made up.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SECRET = 'whsec_example_fixture_secret_not_for_production';
const DELIVERY_ID = '3f6c1a52-8d4e-4b7a-9c21-5e0f7d9b2a14';

// The event as the documentation describes it, built in the documented order.
// Non-ASCII text is deliberate: the accented letters and the emoji are several
// bytes each in UTF-8, so a verifier that hashes anything other than the raw
// bytes fails on this fixture.
const PAYLOAD = {
  event: 'message.received',
  sequence: 1042,
  timestamp: '2026-10-15T14:00:00.000Z',
  data: {
    from: '12025550143',
    user_id: 'US.1A2B3C4D5E6F7G8H9I0J',
    contact_name: 'Alex Rivera',
    contact_username: null,
    message_id: 'wamid.HBgLMTIwMjU1NTAxNDMVAgASGBQzRjZDMUE1MjhENEU0QjdBOUMyMQA=',
    type: 'text',
    timestamp: '1792072798',
    text: { body: 'Hi! Is the café open on Sunday? 👋' },
    from_user_id: 'US.1A2B3C4D5E6F7G8H9I0J',
  },
  account: {
    phone_number_id: '100000000000001',
    display_name: 'Example Café',
    display_phone_number: '+1 202-555-0187',
  },
};

/**
 * A real delivery does not keep the order the payload was built in: ZapClaw
 * records each delivery before sending it and serializes the recorded copy,
 * whose object keys come back sorted by their length in bytes, then byte by
 * byte. The fixture reproduces that order so it reads like what your endpoint
 * actually receives. The signature does not depend on key order, since it
 * covers whatever bytes were sent, and your code must not depend on it either.
 */
const storedKeyOrder = (value) => {
  if (Array.isArray(value)) return value.map(storedKeyOrder);
  if (value === null || typeof value !== 'object') return value;
  const keys = Object.keys(value).sort((a, b) => {
    const lengthA = Buffer.byteLength(a, 'utf8');
    const lengthB = Buffer.byteLength(b, 'utf8');
    if (lengthA !== lengthB) return lengthA - lengthB;
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  });
  const ordered = {};
  for (const key of keys) ordered[key] = storedKeyOrder(value[key]);
  return ordered;
};

/** The same function ZapClaw signs with. */
const sign = (secret, body) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

/**
 * Builds the fixture in memory.
 * @returns {{ body: Buffer, fixture: object }}
 */
const buildFixture = () => {
  const bodyText = JSON.stringify(storedKeyOrder(PAYLOAD));
  const body = Buffer.from(bodyText, 'utf8');
  const fixture = {
    description:
      'A message.received delivery signed the way ZapClaw signs it. Test values only: '
      + 'the body is payload.json, byte for byte, and the signature covers exactly those bytes.',
    secret: SECRET,
    bodyFile: 'payload.json',
    bodyBytes: body.length,
    headers: {
      'Content-Type': 'application/json',
      'X-ZapClaw-Event': PAYLOAD.event,
      'X-ZapClaw-Delivery': DELIVERY_ID,
      'X-ZapClaw-Signature': sign(SECRET, bodyText),
    },
  };
  return { body, fixture };
};

const FIXTURE_DIR = __dirname;
const BODY_PATH = path.join(FIXTURE_DIR, 'payload.json');
const FIXTURE_PATH = path.join(FIXTURE_DIR, 'fixture.json');

const serializeFixture = (fixture) => JSON.stringify(fixture, null, 2) + '\n';

const main = () => {
  const { body, fixture } = buildFixture();
  const fixtureText = serializeFixture(fixture);

  if (process.argv.includes('--check')) {
    const bodyOnDisk = fs.existsSync(BODY_PATH) ? fs.readFileSync(BODY_PATH) : null;
    const fixtureOnDisk = fs.existsSync(FIXTURE_PATH) ? fs.readFileSync(FIXTURE_PATH, 'utf8') : null;
    const stale = [];
    if (!bodyOnDisk || !bodyOnDisk.equals(body)) stale.push('payload.json');
    if (fixtureOnDisk !== fixtureText) stale.push('fixture.json');
    if (stale.length) {
      console.error(`Out of date: ${stale.join(', ')}. Run: node webhook-signature/fixture/generate.js`);
      process.exit(1);
    }
    console.log('Fixture is up to date.');
    return;
  }

  // No trailing newline: the file holds the exact bytes that were signed.
  fs.writeFileSync(BODY_PATH, body);
  fs.writeFileSync(FIXTURE_PATH, fixtureText);
  console.log(`Wrote ${path.relative(process.cwd(), BODY_PATH)} (${body.length} bytes)`);
  console.log(`Wrote ${path.relative(process.cwd(), FIXTURE_PATH)}`);
  console.log(`X-ZapClaw-Signature: ${fixture.headers['X-ZapClaw-Signature']}`);
};

if (require.main === module) main();

module.exports = { buildFixture, serializeFixture, sign, storedKeyOrder, BODY_PATH, FIXTURE_PATH };
