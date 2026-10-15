'use strict';

const crypto = require('node:crypto');

/**
 * Checks the X-ZapClaw-Signature header of a ZapClaw webhook request.
 *
 * ZapClaw signs every webhook with HMAC-SHA256 over the raw request body,
 * keyed with your webhook signing secret, and sends the lowercase hex digest
 * prefixed with "sha256=". Compute the same value over the exact bytes you
 * received and compare the two in constant time.
 *
 * Pass the body as a Buffer taken before any JSON parsing. Parsing and
 * re-serializing changes the bytes (whitespace, key order, escaping), and a
 * signature over different bytes never matches.
 *
 * @param {Buffer} rawBody the request body exactly as received
 * @param {string | undefined} signatureHeader the X-ZapClaw-Signature header value
 * @param {string} secret your webhook signing secret (whsec_...), used as is
 * @returns {boolean} true only when the signature matches
 */
const verifySignature = (rawBody, signatureHeader, secret) => {
  if (!Buffer.isBuffer(rawBody) || typeof signatureHeader !== 'string' || !secret) {
    return false;
  }
  const expected = Buffer.from(
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex'),
    'utf8',
  );
  const received = Buffer.from(signatureHeader, 'utf8');
  // timingSafeEqual throws when the lengths differ, and a different length
  // already means a wrong signature, so check it first.
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
};

module.exports = { verifySignature };
