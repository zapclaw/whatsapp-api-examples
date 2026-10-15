# WhatsApp API examples for ZapClaw

Working, tested code for the three things every integration with the ZapClaw API does:
check that a webhook really came from ZapClaw, send messages, and try every endpoint in
Postman. Node.js, Python, PHP and curl, with no framework beyond the one each example shows.

[ZapClaw][home] connects a WhatsApp Business number to Meta's official WhatsApp Cloud API
through Coexistence, so the number keeps working in the WhatsApp Business app on the phone.
Inbound messages are POSTed to your webhook; you send with a REST call.

**[Start free][register]** · [API and webhook docs][docs] · [Pricing][pricing] · [Português](README.pt-BR.md) · [Español](README.es.md)

| Folder | What it shows | Languages |
|---|---|---|
| [`webhook-signature/`](webhook-signature) | Verify `X-ZapClaw-Signature` over the raw body, in constant time, with a shared signed fixture | Node.js (Express), Python (Flask and plain `hmac`), PHP |
| [`send/`](send) | Send a text and a template, retry safely with `Idempotency-Key`, read every answer | curl, Node.js (`fetch`), Python (`requests`), PHP (curl) |
| [`postman/`](postman) | A Postman collection (v2.1) with all 35 endpoints, generated from the OpenAPI document | Postman |

## Verify webhook signatures

Every webhook ZapClaw sends carries an `X-ZapClaw-Signature` header:

```
X-ZapClaw-Signature: sha256=<hex HMAC-SHA256 of the raw request body, keyed with your signing secret>
```

The signing secret is on the **Webhook** page of the dashboard (`whsec_...`). Four rules
avoid the usual mistakes:

1. **Hash the raw bytes you received**, before any JSON parsing. Parsing and serializing
   again changes spacing, escaping and key order, and the keys of a ZapClaw body do not
   arrive in the order the docs list them. Hash the bytes, never a re-encoded object.
2. **Use the whole secret as text**, `whsec_` prefix included. It is not base64.
3. **Compare in constant time**: `crypto.timingSafeEqual`, `hmac.compare_digest`, `hash_equals`.
4. **Reject first, then parse.** Answer `401` to a bad signature and do nothing else.

After you rotate the secret (**Webhook → Generate new key**), the old one stops validating
at once, so update every verifier right away.

**Node.js** ([`verify.js`](webhook-signature/node/verify.js), Express endpoint in [`server.js`](webhook-signature/node/server.js))

```js
const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
const received = Buffer.from(signatureHeader);
const valid = received.length === expected.length && crypto.timingSafeEqual(received, expected);
```

In Express, mount `express.raw({ type: 'application/json' })` on the webhook route so
`req.body` is a `Buffer`, and register that route before any app-wide `express.json()`.

**Python** ([`verify.py`](webhook-signature/python/verify.py), standard library only; Flask endpoint in [`flask_app.py`](webhook-signature/python/flask_app.py))

```python
expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
valid = hmac.compare_digest(expected.encode(), signature_header.encode())
```

In Flask, `raw_body = request.get_data()`, read before `request.json`.

**PHP** ([`verify.php`](webhook-signature/php/verify.php), endpoint in [`webhook.php`](webhook-signature/php/webhook.php))

```php
$expected = 'sha256=' . hash_hmac('sha256', $rawBody, $secret);
$valid = hash_equals($expected, $signatureHeader);
```

With `$rawBody = file_get_contents('php://input')` and
`$signatureHeader = $_SERVER['HTTP_X_ZAPCLAW_SIGNATURE'] ?? ''`. In Laravel or Symfony,
`$request->getContent()`.

### The shared fixture

[`webhook-signature/fixture/`](webhook-signature/fixture) holds one `message.received`
delivery exactly as ZapClaw sends it: [`payload.json`](webhook-signature/fixture/payload.json)
is the body, byte for byte (one line, no trailing newline, accented letters and an emoji
in UTF-8), and [`fixture.json`](webhook-signature/fixture/fixture.json) has the test
secret and the headers, signature included. Every language's tests accept it and refuse
it after one changed byte, a re-serialized body, a trailing newline or a wrong secret.
[`generate.js`](webhook-signature/fixture/generate.js) rebuilds both files with the same
signing code ZapClaw uses.

Replay it against any of the three endpoints:

```sh
export ZAPCLAW_WEBHOOK_SECRET=whsec_example_fixture_secret_not_for_production
npm install && npm run webhook                       # Node.js, or:
# python webhook-signature/python/flask_app.py       # Python
# php -S localhost:3000 webhook-signature/php/webhook.php   # PHP

curl -i http://localhost:3000/webhooks/zapclaw \
  -H "Content-Type: application/json" \
  -H "X-ZapClaw-Event: message.received" \
  -H "X-ZapClaw-Delivery: 3f6c1a52-8d4e-4b7a-9c21-5e0f7d9b2a14" \
  -H "X-ZapClaw-Signature: sha256=77b7d63452f8e6b0381240c5b029d1e76b0c6dc7954fb229bb0c5a29b390a9d8" \
  --data-binary @webhook-signature/fixture/payload.json
```

`--data-binary` matters: `-d @file` strips line breaks from the file before sending. ZapClaw
only calls public `https://` URLs, so to receive real events on your machine, put a
reverse proxy or a tunnel you control in front of it. Answer with any `2xx` within 10
seconds; otherwise ZapClaw retries, three attempts in all (right away, 30 seconds later,
120 seconds after that). A replay you request from the dashboard carries
`X-ZapClaw-Redelivery`; process it even if you have seen its `message_id`.

## Send messages

Set three variables (a fourth is optional), then run the example in your language:

```sh
export ZAPCLAW_API_KEY=zc_live_...      # dashboard → API Keys (shown once)
export ZAPCLAW_FROM=15550001111         # one of your connected numbers, E.164 digits
export ZAPCLAW_TO=15550002222           # the recipient
# export ZAPCLAW_BASE_URL=https://api.zapclaw.app   (the default)
```

On Windows PowerShell: `$env:ZAPCLAW_API_KEY = "zc_live_..."`, and so on.

| | Text | Template |
|---|---|---|
| curl | `bash send/curl/send-text.sh "Hello"` | `bash send/curl/send-template.sh "#1234"` |
| Node.js 18+ | `node send/node/send-text.js "Hello"` | `node send/node/send-template.js "#1234"` |
| Python | `python send/python/send_text.py "Hello"` | `python send/python/send_template.py "#1234"` |
| PHP 8 | `php send/php/send-text.php "Hello"` | `php send/php/send-template.php "#1234"` |

Python needs `pip install -r send/python/requirements.txt`; PHP needs the curl extension.

The two calls, exactly as the API takes them:

```sh
curl -X POST https://api.zapclaw.app/api/v1/send/text \
  -H "X-API-Key: $ZAPCLAW_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 8f14e45f-ea0e-4f1d-9a2b-1c0d3e5f7a90" \
  -d '{ "from": "15550001111", "to": "15550002222", "text": "Hello from the ZapClaw API" }'

curl -X POST https://api.zapclaw.app/api/v1/send/template \
  -H "X-API-Key: $ZAPCLAW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "15550001111",
    "to": "15550002222",
    "templateName": "order_update",
    "language": "en_US",
    "components": [
      { "type": "body", "parameters": [ { "type": "text", "text": "#1234" } ] }
    ]
  }'
```

- **Text** takes `from`, `to`, `text` (up to 4096 characters), and optionally `previewUrl`
  and `replyTo` (the wamid of a message to quote). A free-form message only reaches a
  contact who wrote to you in the last 24 hours.
- **Template** takes `from`, `to`, `templateName`, `language`, `components` (Meta's
  format) and optionally `replyTo`. It is not bound to the 24-hour window. The template must be
  approved on the sending number; `GET /api/v1/send/templates` lists them. When
  `language` is missing the API uses `pt_BR`, so always send the language the template
  was approved in. The template examples set it from `ZAPCLAW_TEMPLATE_LANGUAGE`
  (default `en_US`) and the name from `ZAPCLAW_TEMPLATE` (default `order_update`).

### What comes back

| Status | Meaning | What the examples do |
|---|---|---|
| `201` | Sent. The body holds the message with its `wamid`. | Print it, exit `0`. |
| `202` | **Delivery unknown.** Meta reported a failure that does not rule out delivery; the message may already be on the phone. | Print the warning and the `Idempotency-Key`, exit `2`. Never retry it with a new key. |
| `422` | The 24-hour window is closed (`meta_code: 131047`): send a template. Or the `Idempotency-Key` was already used for another request. | Print the error, exit `1`. |
| other `4xx`, `5xx` | Refused: the body says why in `error`, and in `meta_code` when the refusal came from Meta. | Print it, exit `1`. |

Every status is in the [error reference][docs-errors].

### Retrying without sending twice

Every example sends an `Idempotency-Key` header. Repeating the same request with the
same key within 10 minutes returns the first answer instead of sending a second
message. The examples print the key whenever a send does not end in `201`; to retry that
exact send, run it again with `ZAPCLAW_IDEMPOTENCY_KEY` set to the printed key. More in
the [idempotency docs][docs-idempotency].

## Postman collection

Import [`postman/zapclaw-api.postman_collection.json`](postman/zapclaw-api.postman_collection.json)
(Postman: **Import**, then pick the file), open the collection's **Variables** and set:

| Variable | Value |
|---|---|
| `apiKey` | your API key; every request sends it as `X-API-Key` through the collection's API Key authorization |
| `from` | one of your connected numbers, E.164 digits |
| `to` | a recipient |
| `baseUrl` | `https://api.zapclaw.app` (already set) |

The collection has one folder per area (Messages, Numbers, Media, Templates, Profile,
Block, QR Codes, Automation, Analytics) and every endpoint of
[`openapi.yaml`](postman/openapi.yaml), a copy of [the published spec][openapi].

It is generated, so it never drifts from the spec:

```sh
node postman/build-collection.js            # rebuild from postman/openapi.yaml
node postman/check-collection.js            # validate it against openapi.yaml
node postman/check-collection.js --cross-check   # also compare the YAML reader with js-yaml (via npx)
```

The generator has no dependencies and needs no network: it reads the YAML with
[`yaml-subset.js`](postman/yaml-subset.js), which covers what OpenAPI files use and
stops with the line number on anything else. The check confirms that every request's
method and path exist in `openapi.yaml` (read with a separate line scan), that every
operation is in the collection once, and that every body and parameter is one the
spec documents. To refresh the spec first:

```sh
curl -o postman/openapi.yaml "https://zapclaw.app/openapi.yaml?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples"
```

## Run the tests

```sh
npm install                 # Express, for the Node.js webhook example
npm test                    # Node.js tests; also runs every send example against a local mock of the API
python -m unittest discover -s webhook-signature/python/tests -v
php webhook-signature/php/test.php
```

`npm test` runs the Python, PHP and curl send examples too when their runtime is
installed (Python with `requests`, PHP with the curl extension, bash with curl) and
skips the ones that are not. The Flask tests are skipped without Flask
(`pip install -r webhook-signature/python/requirements.txt`). Nothing calls the real API.

## More from ZapClaw

- [n8n-whatsapp-official-api](https://github.com/zapclaw/n8n-whatsapp-official-api): WhatsApp in n8n on the official API, with ZapClaw ([guide][n8n])
- [chatwoot-zapclaw](https://github.com/zapclaw/chatwoot-zapclaw): Chatwoot self-hosted with the number still on the phone
- [migrate-to-whatsapp-official-api](https://github.com/zapclaw/migrate-to-whatsapp-official-api): moving an integration to the official API, with guides for [Evolution API][migrate-evolution], [Z-API][migrate-zapi] and [WAHA][migrate-waha]
- Guides: [the official WhatsApp API with ZapClaw][official], [unofficial or official API][unofficial], [Coexistence requirements][coex], [Evolution API compared][vs-evolution], [Z-API compared][vs-zapi], and WhatsApp with [Make][make], [Typebot][typebot], [Dify][dify] and [Flowise][flowise]
- [About ZapClaw][about]

## Security

Issues here are public. Never paste an API key (`zc_live_...`), a signing secret
(`whsec_...`) or a real phone number into one. The secret in the fixture is a test value
that signs nothing real. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

This repository is maintained by ZapClaw and is not affiliated with or endorsed by Meta.
WhatsApp is a trademark of Meta Platforms, Inc.

[home]: https://zapclaw.app/?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[register]: https://app.zapclaw.app/register?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[docs]: https://zapclaw.app/docs.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[docs-errors]: https://zapclaw.app/docs.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples#errors
[docs-idempotency]: https://zapclaw.app/docs.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples#idempotency
[openapi]: https://zapclaw.app/openapi.yaml?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[pricing]: https://zapclaw.app/pricing.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[official]: https://zapclaw.app/whatsapp-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[unofficial]: https://zapclaw.app/unofficial-vs-official-whatsapp-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[coex]: https://zapclaw.app/coexistence-requirements.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[vs-evolution]: https://zapclaw.app/zapclaw-vs-evolution-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[vs-zapi]: https://zapclaw.app/zapclaw-vs-z-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[migrate-evolution]: https://zapclaw.app/migrate-evolution-api-to-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[migrate-zapi]: https://zapclaw.app/migrate-z-api-to-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[migrate-waha]: https://zapclaw.app/migrate-waha-to-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[n8n]: https://zapclaw.app/n8n-whatsapp-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[make]: https://zapclaw.app/make-whatsapp-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[typebot]: https://zapclaw.app/typebot-whatsapp-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[dify]: https://zapclaw.app/dify-whatsapp-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[flowise]: https://zapclaw.app/flowise-whatsapp-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[about]: https://zapclaw.app/about.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
