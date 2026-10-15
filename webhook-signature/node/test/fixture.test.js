'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');

const {
  buildFixture, serializeFixture, BODY_PATH, FIXTURE_PATH,
} = require('../../fixture/generate');

test('payload.json and fixture.json match what generate.js produces', () => {
  const { body, fixture } = buildFixture();
  assert.ok(fs.readFileSync(BODY_PATH).equals(body), 'payload.json is stale: run node webhook-signature/fixture/generate.js');
  assert.equal(fs.readFileSync(FIXTURE_PATH, 'utf8'), serializeFixture(fixture), 'fixture.json is stale');
});

test('payload.json is one line of compact JSON with no trailing newline', () => {
  const raw = fs.readFileSync(BODY_PATH);
  assert.notEqual(raw[raw.length - 1], 0x0a);
  assert.equal(raw.includes(0x0d), false);
  assert.equal(raw.includes(0x0a), false);
  const text = raw.toString('utf8');
  assert.equal(JSON.stringify(JSON.parse(text)), text);
});

test('the signature is HMAC-SHA256 of the file bytes, keyed with the secret text', () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const digest = crypto.createHmac('sha256', Buffer.from(fixture.secret, 'utf8'))
    .update(fs.readFileSync(BODY_PATH))
    .digest('hex');
  assert.equal(fixture.headers['X-ZapClaw-Signature'], `sha256=${digest}`);
});
