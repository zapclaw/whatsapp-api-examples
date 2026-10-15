'use strict';

/**
 * A minimal Express endpoint that receives ZapClaw webhooks and rejects any
 * request whose X-ZapClaw-Signature does not match.
 *
 *   npm install
 *   ZAPCLAW_WEBHOOK_SECRET=whsec_... node webhook-signature/node/server.js
 *
 * It listens on http://localhost:3000/webhooks/zapclaw (PORT changes the port).
 * ZapClaw only calls public https URLs, so put a reverse proxy or a tunnel you
 * control in front of it to receive real events.
 */

const express = require('express');
const { verifySignature } = require('./verify');

/** Default handler: prints one line per event. Replace it with your own. */
const logEvent = (event, { eventType, deliveryId, redeliveryOf }) => {
  const replay = redeliveryOf ? ` (replay of ${redeliveryOf})` : '';
  if (eventType === 'message.received' && event.data && event.data.type === 'text') {
    console.log(`[${deliveryId}]${replay} text from ${event.data.user_id}: ${event.data.text.body}`);
  } else {
    console.log(`[${deliveryId}]${replay} ${eventType}`);
  }
};

/**
 * @param {object} options
 * @param {string} options.secret your webhook signing secret
 * @param {(event: object, meta: { eventType: string, deliveryId: string, redeliveryOf: string }) => void} [options.onEvent]
 *   called with every verified event, after the response has been sent
 */
const createApp = ({ secret, onEvent = logEvent }) => {
  if (!secret) {
    throw new Error('Set ZAPCLAW_WEBHOOK_SECRET to the signing secret shown on the Webhook page of the dashboard.');
  }

  const app = express();

  // express.raw keeps the body as a Buffer for this route only. If your app
  // also uses express.json(), register this route before it: once a JSON
  // parser has read the stream, the original bytes are gone and no signature
  // can be checked.
  app.post(
    '/webhooks/zapclaw',
    express.raw({ type: 'application/json', limit: '1mb' }),
    (req, res) => {
      if (!verifySignature(req.body, req.get('X-ZapClaw-Signature'), secret)) {
        return res.status(401).json({ error: 'invalid signature' });
      }

      let event;
      try {
        event = JSON.parse(req.body.toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'body is not JSON' });
      }

      // Answer first: ZapClaw waits 10 seconds for a 2xx and retries
      // otherwise. Slow work (a database, an AI model, another API) belongs
      // after the response or on a queue.
      res.status(200).json({ received: true });

      onEvent(event, {
        eventType: req.get('X-ZapClaw-Event'),
        deliveryId: req.get('X-ZapClaw-Delivery'),
        // Present only on a replay you asked for from the dashboard. Process
        // it even if you have already seen its message_id.
        redeliveryOf: req.get('X-ZapClaw-Redelivery'),
      });
    },
  );

  return app;
};

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp({ secret: process.env.ZAPCLAW_WEBHOOK_SECRET }).listen(port, () => {
    console.log(`Listening on http://localhost:${port}/webhooks/zapclaw`);
  });
}

module.exports = { createApp };
