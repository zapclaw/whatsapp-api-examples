# Ejemplos de la API de WhatsApp de ZapClaw

Código probado para las tres cosas que hace toda integración con la API de ZapClaw:
comprobar que un webhook viene de verdad de ZapClaw, enviar mensajes y probar cada
endpoint en Postman. Node.js, Python, PHP y curl, sin más framework que el que muestra
cada ejemplo.

[ZapClaw][home] conecta un número de WhatsApp Business a la API oficial de WhatsApp de Meta
(Cloud API) mediante Coexistencia, así que el número sigue funcionando en la app WhatsApp
Business del teléfono. Los mensajes entrantes llegan por POST a tu webhook; tú envías con
una llamada REST.

**[Empieza gratis][register]** · [Documentación de la API y del webhook (en inglés)][docs] · [Precios][pricing] · [English](README.md) · [Português](README.pt-BR.md)

| Carpeta | Qué muestra | Lenguajes |
|---|---|---|
| [`webhook-signature/`](webhook-signature) | Verificar `X-ZapClaw-Signature` sobre el cuerpo sin procesar, en tiempo constante, con un fixture firmado compartido | Node.js (Express), Python (Flask y `hmac` puro), PHP |
| [`send/`](send) | Enviar un texto y una plantilla, reintentar con seguridad usando `Idempotency-Key`, interpretar cada respuesta | curl, Node.js (`fetch`), Python (`requests`), PHP (curl) |
| [`postman/`](postman) | Una colección de Postman (v2.1) con los 35 endpoints, generada a partir del documento OpenAPI | Postman |

## Verificar la firma del webhook

Cada webhook que envía ZapClaw lleva el encabezado `X-ZapClaw-Signature`:

```
X-ZapClaw-Signature: sha256=<HMAC-SHA256 en hexadecimal del cuerpo sin procesar, calculado con tu clave de firma>
```

La clave de firma está en la página **Webhook** del panel (`whsec_...`). Cuatro reglas
evitan los errores habituales:

1. **Calcula el hash sobre los bytes que recibiste**, antes de cualquier parseo de JSON.
   Parsear y volver a serializar cambia espacios, escapes y el orden de las claves, y las
   claves de un cuerpo de ZapClaw no llegan en el orden en que las lista la
   documentación. Usa los bytes, nunca un objeto recodificado.
2. **Usa la clave completa como texto**, con el prefijo `whsec_`. No es base64.
3. **Compara en tiempo constante**: `crypto.timingSafeEqual`, `hmac.compare_digest`, `hash_equals`.
4. **Primero rechaza, después parsea.** Responde `401` a una firma inválida y no hagas nada más.

Después de cambiar la clave (**Webhook → Generar nueva clave**), la anterior deja de
validar al instante, así que actualiza todos los verificadores enseguida.

**Node.js** ([`verify.js`](webhook-signature/node/verify.js), endpoint Express en [`server.js`](webhook-signature/node/server.js))

```js
const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
const received = Buffer.from(signatureHeader);
const valid = received.length === expected.length && crypto.timingSafeEqual(received, expected);
```

En Express, monta `express.raw({ type: 'application/json' })` en la ruta del webhook para
que `req.body` sea un `Buffer`, y registra esa ruta antes de cualquier `express.json()` global.

**Python** ([`verify.py`](webhook-signature/python/verify.py), solo biblioteca estándar; endpoint Flask en [`flask_app.py`](webhook-signature/python/flask_app.py))

```python
expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
valid = hmac.compare_digest(expected.encode(), signature_header.encode())
```

En Flask, `raw_body = request.get_data()`, leído antes de `request.json`.

**PHP** ([`verify.php`](webhook-signature/php/verify.php), endpoint en [`webhook.php`](webhook-signature/php/webhook.php))

```php
$expected = 'sha256=' . hash_hmac('sha256', $rawBody, $secret);
$valid = hash_equals($expected, $signatureHeader);
```

Con `$rawBody = file_get_contents('php://input')` y
`$signatureHeader = $_SERVER['HTTP_X_ZAPCLAW_SIGNATURE'] ?? ''`. En Laravel o Symfony,
`$request->getContent()`.

### El fixture compartido

[`webhook-signature/fixture/`](webhook-signature/fixture) guarda una entrega
`message.received` tal como la envía ZapClaw: [`payload.json`](webhook-signature/fixture/payload.json)
es el cuerpo, byte a byte (una línea, sin salto de línea al final, letras con tilde y un
emoji en UTF-8), y [`fixture.json`](webhook-signature/fixture/fixture.json) tiene la clave
de prueba y los encabezados, con la firma. Las pruebas de todos los lenguajes aceptan
ese cuerpo y lo rechazan tras un byte cambiado, una nueva serialización, un salto de
línea añadido al final o una clave equivocada. [`generate.js`](webhook-signature/fixture/generate.js)
vuelve a crear los dos archivos con el mismo código de firma que usa ZapClaw.

Reenvía el fixture a cualquiera de los tres endpoints:

```sh
export ZAPCLAW_WEBHOOK_SECRET=whsec_example_fixture_secret_not_for_production
npm install && npm run webhook                       # Node.js, o bien:
# python webhook-signature/python/flask_app.py       # Python
# php -S localhost:3000 webhook-signature/php/webhook.php   # PHP

curl -i http://localhost:3000/webhooks/zapclaw \
  -H "Content-Type: application/json" \
  -H "X-ZapClaw-Event: message.received" \
  -H "X-ZapClaw-Delivery: 3f6c1a52-8d4e-4b7a-9c21-5e0f7d9b2a14" \
  -H "X-ZapClaw-Signature: sha256=77b7d63452f8e6b0381240c5b029d1e76b0c6dc7954fb229bb0c5a29b390a9d8" \
  --data-binary @webhook-signature/fixture/payload.json
```

`--data-binary` importa: `-d @archivo` quita los saltos de línea del archivo antes de enviarlo.
ZapClaw solo llama a URLs públicas `https://`, así que, para recibir eventos reales en tu
máquina, pon delante un proxy inverso o un túnel que controles. Responde con cualquier
`2xx` en menos de 10 segundos; si no, ZapClaw reintenta, tres intentos en total (al
momento, 30 segundos después y 120 segundos después de eso). Un reenvío que pides desde
el panel lleva `X-ZapClaw-Redelivery`; procésalo aunque ya hayas visto su `message_id`.

## Enviar mensajes

Define tres variables (una cuarta es opcional) y ejecuta el ejemplo de tu lenguaje:

```sh
export ZAPCLAW_API_KEY=zc_live_...      # panel → Claves de API (se muestra una sola vez)
export ZAPCLAW_FROM=15550001111         # uno de tus números conectados, dígitos E.164
export ZAPCLAW_TO=15550002222           # el destinatario
# export ZAPCLAW_BASE_URL=https://api.zapclaw.app   (el valor por defecto)
```

En PowerShell de Windows: `$env:ZAPCLAW_API_KEY = "zc_live_..."`, y así con las demás.

| | Texto | Plantilla |
|---|---|---|
| curl | `bash send/curl/send-text.sh "Hola"` | `bash send/curl/send-template.sh "#1234"` |
| Node.js 18+ | `node send/node/send-text.js "Hola"` | `node send/node/send-template.js "#1234"` |
| Python | `python send/python/send_text.py "Hola"` | `python send/python/send_template.py "#1234"` |
| PHP 8 | `php send/php/send-text.php "Hola"` | `php send/php/send-template.php "#1234"` |

Python necesita `pip install -r send/python/requirements.txt`; PHP necesita la extensión curl.

Las dos llamadas, tal como las recibe la API:

```sh
curl -X POST https://api.zapclaw.app/api/v1/send/text \
  -H "X-API-Key: $ZAPCLAW_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 8f14e45f-ea0e-4f1d-9a2b-1c0d3e5f7a90" \
  -d '{ "from": "15550001111", "to": "15550002222", "text": "Hola desde la API de ZapClaw" }'

curl -X POST https://api.zapclaw.app/api/v1/send/template \
  -H "X-API-Key: $ZAPCLAW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "15550001111",
    "to": "15550002222",
    "templateName": "order_update",
    "language": "es",
    "components": [
      { "type": "body", "parameters": [ { "type": "text", "text": "#1234" } ] }
    ]
  }'
```

- **Texto** recibe `from`, `to`, `text` (hasta 4096 caracteres) y, si quieres,
  `previewUrl` y `replyTo` (el wamid de un mensaje a citar). Un mensaje libre solo llega
  a un contacto que te escribió en las últimas 24 horas.
- **Plantilla** recibe `from`, `to`, `templateName`, `language`, `components` (en el
  formato de Meta) y, si quieres, `replyTo`. No depende de la ventana de 24 horas. La
  plantilla tiene que estar aprobada en el número que envía; `GET /api/v1/send/templates`
  lista las disponibles. Sin `language`, la API usa `pt_BR`, así que envía siempre el
  idioma en que se aprobó la plantilla. Los ejemplos de plantilla toman el idioma de
  `ZAPCLAW_TEMPLATE_LANGUAGE` (por defecto `en_US`) y el nombre de `ZAPCLAW_TEMPLATE`
  (por defecto `order_update`).

### Qué vuelve

| Estado | Significado | Qué hacen los ejemplos |
|---|---|---|
| `201` | Enviado. El cuerpo trae el mensaje con su `wamid`. | Lo muestran y salen con `0`. |
| `202` | **Entrega desconocida.** Meta informó un fallo que no descarta la entrega; el mensaje puede estar ya en el teléfono. | Muestran el aviso y la `Idempotency-Key` y salen con `2`. Nunca lo reintentes con una clave nueva. |
| `422` | La ventana de 24 horas está cerrada (`meta_code: 131047`): envía una plantilla. O la `Idempotency-Key` ya se usó en otra solicitud. | Muestran el error y salen con `1`. |
| otros `4xx`, `5xx` | Rechazado: el cuerpo dice el motivo en `error`, y en `meta_code` cuando el rechazo vino de Meta. | Lo muestran y salen con `1`. |

Todos los estados están en la [referencia de errores (en inglés)][docs-errors].

### Reintentar sin enviar dos veces

Cada ejemplo envía el encabezado `Idempotency-Key`. Repetir la misma solicitud con la
misma clave dentro de 10 minutos devuelve la primera respuesta en lugar de enviar un
segundo mensaje. Los ejemplos muestran la clave cuando un envío no termina en `201`; para
reintentar exactamente ese envío, ejecútalo de nuevo con `ZAPCLAW_IDEMPOTENCY_KEY` igual a
la clave mostrada. Más en la [documentación de idempotencia (en inglés)][docs-idempotency].

## Colección de Postman

Importa [`postman/zapclaw-api.postman_collection.json`](postman/zapclaw-api.postman_collection.json)
(en Postman: **Import** y elige el archivo), abre las **Variables** de la colección y completa:

| Variable | Valor |
|---|---|
| `apiKey` | tu clave de API; cada solicitud la envía como `X-API-Key` mediante la autorización API Key de la colección |
| `from` | uno de tus números conectados, dígitos E.164 |
| `to` | un destinatario |
| `baseUrl` | `https://api.zapclaw.app` (ya definida) |

La colección tiene una carpeta por área (Messages, Numbers, Media, Templates, Profile,
Block, QR Codes, Automation, Analytics) y todos los endpoints de
[`openapi.yaml`](postman/openapi.yaml), una copia de la [especificación publicada][openapi].

Es generada, así que nunca se separa de la especificación:

```sh
node postman/build-collection.js            # la vuelve a crear desde postman/openapi.yaml
node postman/check-collection.js            # la valida contra openapi.yaml
node postman/check-collection.js --cross-check   # además compara el lector de YAML con js-yaml (vía npx)
```

El generador no tiene dependencias ni necesita red: lee el YAML con
[`yaml-subset.js`](postman/yaml-subset.js), que cubre lo que usan los archivos OpenAPI y
se detiene con el número de línea ante cualquier otra cosa. La comprobación confirma que
el método y la ruta de cada solicitud existen en `openapi.yaml` (leído con un recorrido
de líneas aparte), que cada operación está en la colección una vez y que cada cuerpo y
cada parámetro son los que documenta la especificación. Para actualizar antes la
especificación:

```sh
curl -o postman/openapi.yaml "https://zapclaw.app/openapi.yaml?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples"
```

## Ejecutar las pruebas

```sh
npm install                 # Express, para el ejemplo de webhook en Node.js
npm test                    # pruebas en Node.js; también ejecuta cada ejemplo de envío contra un mock local de la API
python -m unittest discover -s webhook-signature/python/tests -v
php webhook-signature/php/test.php
```

`npm test` también ejecuta los ejemplos de envío en Python, PHP y curl cuando su entorno
está instalado (Python con `requests`, PHP con la extensión curl, bash con curl) y omite
los que no lo están. Las pruebas de Flask se omiten sin Flask
(`pip install -r webhook-signature/python/requirements.txt`). Nada llama a la API real.

## Más de ZapClaw

- [n8n-whatsapp-official-api](https://github.com/zapclaw/n8n-whatsapp-official-api): WhatsApp en n8n con la API oficial, mediante ZapClaw ([guía][n8n])
- [chatwoot-zapclaw](https://github.com/zapclaw/chatwoot-zapclaw): Chatwoot self-hosted con el número todavía en el teléfono
- [migrate-to-whatsapp-official-api](https://github.com/zapclaw/migrate-to-whatsapp-official-api): migrar una integración a la API oficial, con guías para [Evolution API][migrate-evolution], [Z-API][migrate-zapi] y [WAHA][migrate-waha]
- Guías: [la API oficial de WhatsApp con ZapClaw][official], [API no oficial u oficial][unofficial], [requisitos de la Coexistencia][coex], [comparación con Evolution API][vs-evolution], [comparación con Z-API][vs-zapi], y WhatsApp con [Make][make], [Typebot][typebot], [Dify][dify] y [Flowise][flowise]
- [Sobre ZapClaw][about]

## Seguridad

Los issues de este repositorio son públicos. Nunca pegues en ellos una clave de API
(`zc_live_...`), una clave de firma (`whsec_...`) ni un número de teléfono real. La clave
del fixture es un valor de prueba que no firma nada real. Consulta [SECURITY.md](SECURITY.md).

## Licencia

MIT. Consulta [LICENSE](LICENSE).

Este repositorio lo mantiene ZapClaw y no está afiliado a Meta ni cuenta con su respaldo.
WhatsApp es una marca de Meta Platforms, Inc.

[home]: https://zapclaw.app/es/?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[register]: https://app.zapclaw.app/register?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[docs]: https://zapclaw.app/docs.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[docs-errors]: https://zapclaw.app/docs.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples#errors
[docs-idempotency]: https://zapclaw.app/docs.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples#idempotency
[openapi]: https://zapclaw.app/openapi.yaml?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[pricing]: https://zapclaw.app/es/pricing.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[official]: https://zapclaw.app/es/whatsapp-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[unofficial]: https://zapclaw.app/es/unofficial-vs-official-whatsapp-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[coex]: https://zapclaw.app/es/coexistence-requirements.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[vs-evolution]: https://zapclaw.app/es/zapclaw-vs-evolution-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[vs-zapi]: https://zapclaw.app/es/zapclaw-vs-z-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[migrate-evolution]: https://zapclaw.app/es/migrate-evolution-api-to-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[migrate-zapi]: https://zapclaw.app/es/migrate-z-api-to-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[migrate-waha]: https://zapclaw.app/es/migrate-waha-to-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[n8n]: https://zapclaw.app/es/n8n-whatsapp-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[make]: https://zapclaw.app/es/make-whatsapp-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[typebot]: https://zapclaw.app/es/typebot-whatsapp-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[dify]: https://zapclaw.app/es/dify-whatsapp-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[flowise]: https://zapclaw.app/es/flowise-whatsapp-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[about]: https://zapclaw.app/es/about.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
