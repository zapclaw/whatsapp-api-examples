'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { verifySignature } = require('../verify');

const FIXTURE_DIR = path.join(__dirname, '..', '..', 'fixture');
const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'fixture.json'), 'utf8'));
const body = fs.readFileSync(path.join(FIXTURE_DIR, fixture.bodyFile));
const signature = fixture.headers['X-ZapClaw-Signature'];
const { secret } = fixture;

/** A copy of the body with one character of the message text changed. */
const tamperedBody = () => {
  const copy = Buffer.from(body);
  const at = copy.indexOf('Sunday');
  assert.ok(at > 0, 'fixture text not found');
  copy[at] = 'M'.charCodeAt(0);
  return copy;
};

test('the fixture body has the size the fixture declares', () => {
  assert.equal(body.length, fixture.bodyBytes);
});

test('accepts the fixture body with its signature', () => {
  assert.equal(verifySignature(body, signature, secret), true);
});

test('rejects a body with one byte changed', () => {
  assert.equal(verifySignature(tamperedBody(), signature, secret), false);
});

test('rejects the same JSON re-serialized with other whitespace', () => {
  const pretty = Buffer.from(JSON.stringify(JSON.parse(body.toString('utf8')), null, 2), 'utf8');
  assert.notDeepEqual(pretty, body);
  assert.equal(verifySignature(pretty, signature, secret), false);
});

test('rejects the body with a trailing newline added', () => {
  assert.equal(verifySignature(Buffer.concat([body, Buffer.from('\n')]), signature, secret), false);
});

test('rejects a different secret', () => {
  assert.equal(verifySignature(body, signature, secret + 'x'), false);
  assert.equal(verifySignature(body, signature, ''), false);
});

test('rejects missing or malformed headers without throwing', () => {
  const digest = signature.slice('sha256='.length);
  for (const header of [
    undefined,
    '',
    'sha256=',
    digest,
    'sha1=' + digest,
    'SHA256=' + digest,
    'sha256=' + digest.toUpperCase(),
    signature + ' ',
    signature.slice(0, -1),
    'sha256=' + 'é'.repeat(32),
  ]) {
    assert.equal(verifySignature(body, header, secret), false, `header ${JSON.stringify(header)}`);
  }
});

test('refuses a body that is not a Buffer', () => {
  assert.equal(verifySignature(body.toString('utf8'), signature, secret), false);
  assert.equal(verifySignature(JSON.parse(body.toString('utf8')), signature, secret), false);
  assert.equal(verifySignature(undefined, signature, secret), false);
});

test('Express endpoint', async (t) => {
  let express;
  try {
    express = require('express');
  } catch {
    t.skip('express is not installed: run npm install');
    return;
  }
  assert.ok(express);
  const { createApp } = require('../server');

  const received = [];
  const app = createApp({ secret, onEvent: (event, meta) => received.push({ event, meta }) });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/webhooks/zapclaw`;

  const post = (payload, headers = fixture.headers) =>
    fetch(url, { method: 'POST', headers, body: payload });

  await t.test('answers 200 and hands over the parsed event', async () => {
    const response = await post(body);
    assert.equal(response.status, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0].event.data.text.body, 'Hi! Is the café open on Sunday? 👋');
    assert.equal(received[0].meta.eventType, 'message.received');
    assert.equal(received[0].meta.deliveryId, fixture.headers['X-ZapClaw-Delivery']);
    assert.equal(received[0].meta.redeliveryOf, undefined);
  });

  await t.test('answers 401 to a tampered body and hands over nothing', async () => {
    const response = await post(tamperedBody());
    assert.equal(response.status, 401);
    assert.equal(received.length, 1);
  });

  await t.test('answers 401 without a signature header', async () => {
    const headers = { ...fixture.headers };
    delete headers['X-ZapClaw-Signature'];
    const response = await post(body, headers);
    assert.equal(response.status, 401);
    assert.equal(received.length, 1);
  });

  await t.test('passes X-ZapClaw-Redelivery through on a replay', async () => {
    const original = '0b9a3c1e-2f4d-4e6a-8b7c-9d0e1f2a3b4c';
    const response = await post(body, { ...fixture.headers, 'X-ZapClaw-Redelivery': original });
    assert.equal(response.status, 200);
    assert.equal(received.length, 2);
    assert.equal(received[1].meta.redeliveryOf, original);
  });
});
