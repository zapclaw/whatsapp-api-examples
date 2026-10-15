# Exemplos da API de WhatsApp do ZapClaw

Código testado para as três coisas que toda integração com a API do ZapClaw faz:
conferir se um webhook veio mesmo do ZapClaw, enviar mensagens e testar cada endpoint no
Postman. Node.js, Python, PHP e curl, sem framework além daquele que cada exemplo mostra.

O [ZapClaw][home] conecta um número de WhatsApp Business à API oficial do WhatsApp da Meta
(Cloud API) pela Coexistência, então o número continua funcionando no app WhatsApp
Business do celular. As mensagens recebidas chegam por POST no seu webhook; você envia
com uma chamada REST.

**[Comece grátis][register]** · [Documentação da API e do webhook (em inglês)][docs] · [Preços][pricing] · [English](README.md) · [Español](README.es.md)

| Pasta | O que mostra | Linguagens |
|---|---|---|
| [`webhook-signature/`](webhook-signature) | Validar o `X-ZapClaw-Signature` sobre o corpo bruto, em tempo constante, com um fixture assinado compartilhado | Node.js (Express), Python (Flask e `hmac` puro), PHP |
| [`send/`](send) | Enviar um texto e um template, repetir com segurança usando `Idempotency-Key`, interpretar cada resposta | curl, Node.js (`fetch`), Python (`requests`), PHP (curl) |
| [`postman/`](postman) | Uma coleção do Postman (v2.1) com os 35 endpoints, gerada a partir do documento OpenAPI | Postman |

## Validar a assinatura do webhook

Todo webhook que o ZapClaw envia traz o cabeçalho `X-ZapClaw-Signature`:

```
X-ZapClaw-Signature: sha256=<HMAC-SHA256 em hexadecimal do corpo bruto da requisição, calculado com a sua chave de assinatura>
```

A chave de assinatura fica na página **Webhook** do painel (`whsec_...`). Quatro regras
evitam os erros mais comuns:

1. **Calcule o hash sobre os bytes brutos que chegaram**, antes de qualquer parse de JSON.
   Fazer o parse e serializar de novo muda espaços, escapes e a ordem das chaves, e as
   chaves de um corpo do ZapClaw não chegam na ordem em que a documentação as lista.
   Use os bytes, nunca um objeto recodificado.
2. **Use a chave inteira como texto**, com o prefixo `whsec_`. Ela não é base64.
3. **Compare em tempo constante**: `crypto.timingSafeEqual`, `hmac.compare_digest`, `hash_equals`.
4. **Recuse primeiro, faça o parse depois.** Responda `401` a uma assinatura inválida e não faça mais nada.

Depois de trocar a chave (**Webhook → Gerar nova chave**), a antiga para de validar na
hora, então atualize todos os verificadores em seguida.

**Node.js** ([`verify.js`](webhook-signature/node/verify.js), endpoint Express em [`server.js`](webhook-signature/node/server.js))

```js
const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
const received = Buffer.from(signatureHeader);
const valid = received.length === expected.length && crypto.timingSafeEqual(received, expected);
```

No Express, monte `express.raw({ type: 'application/json' })` na rota do webhook para que
`req.body` seja um `Buffer`, e registre essa rota antes de qualquer `express.json()` global.

**Python** ([`verify.py`](webhook-signature/python/verify.py), só biblioteca padrão; endpoint Flask em [`flask_app.py`](webhook-signature/python/flask_app.py))

```python
expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
valid = hmac.compare_digest(expected.encode(), signature_header.encode())
```

No Flask, `raw_body = request.get_data()`, lido antes de `request.json`.

**PHP** ([`verify.php`](webhook-signature/php/verify.php), endpoint em [`webhook.php`](webhook-signature/php/webhook.php))

```php
$expected = 'sha256=' . hash_hmac('sha256', $rawBody, $secret);
$valid = hash_equals($expected, $signatureHeader);
```

Com `$rawBody = file_get_contents('php://input')` e
`$signatureHeader = $_SERVER['HTTP_X_ZAPCLAW_SIGNATURE'] ?? ''`. No Laravel ou no Symfony,
`$request->getContent()`.

### O fixture compartilhado

[`webhook-signature/fixture/`](webhook-signature/fixture) guarda uma entrega
`message.received` exatamente como o ZapClaw envia: [`payload.json`](webhook-signature/fixture/payload.json)
é o corpo, byte a byte (uma linha, sem quebra de linha no final, letras acentuadas e um
emoji em UTF-8), e [`fixture.json`](webhook-signature/fixture/fixture.json) tem a chave
de teste e os cabeçalhos, com a assinatura. Os testes de todas as linguagens aceitam esse
corpo e o recusam depois de um byte alterado, de uma nova serialização, de uma quebra de
linha a mais no final ou de uma chave errada. O [`generate.js`](webhook-signature/fixture/generate.js)
refaz os dois arquivos com o mesmo código de assinatura que o ZapClaw usa.

Reenvie o fixture para qualquer um dos três endpoints:

```sh
export ZAPCLAW_WEBHOOK_SECRET=whsec_example_fixture_secret_not_for_production
npm install && npm run webhook                       # Node.js, ou:
# python webhook-signature/python/flask_app.py       # Python
# php -S localhost:3000 webhook-signature/php/webhook.php   # PHP

curl -i http://localhost:3000/webhooks/zapclaw \
  -H "Content-Type: application/json" \
  -H "X-ZapClaw-Event: message.received" \
  -H "X-ZapClaw-Delivery: 3f6c1a52-8d4e-4b7a-9c21-5e0f7d9b2a14" \
  -H "X-ZapClaw-Signature: sha256=77b7d63452f8e6b0381240c5b029d1e76b0c6dc7954fb229bb0c5a29b390a9d8" \
  --data-binary @webhook-signature/fixture/payload.json
```

O `--data-binary` faz diferença: `-d @arquivo` tira as quebras de linha do arquivo antes
de enviar. O ZapClaw só chama URLs públicas `https://`, então, para receber eventos reais
na sua máquina, coloque na frente um proxy reverso ou um túnel que você controle.
Responda com qualquer `2xx` em até 10 segundos; senão o ZapClaw tenta de novo, três
tentativas no total (na hora, 30 segundos depois e 120 segundos depois disso). Um
reenvio que você pede pelo painel traz `X-ZapClaw-Redelivery`; processe esse evento
mesmo que você já tenha visto o `message_id` dele.

## Enviar mensagens

Defina três variáveis (uma quarta é opcional) e rode o exemplo da sua linguagem:

```sh
export ZAPCLAW_API_KEY=zc_live_...      # painel → Chaves de API (aparece uma vez só)
export ZAPCLAW_FROM=15550001111         # um dos seus números conectados, dígitos E.164
export ZAPCLAW_TO=15550002222           # o destinatário
# export ZAPCLAW_BASE_URL=https://api.zapclaw.app   (o padrão)
```

No PowerShell do Windows: `$env:ZAPCLAW_API_KEY = "zc_live_..."`, e assim por diante.

| | Texto | Template |
|---|---|---|
| curl | `bash send/curl/send-text.sh "Olá"` | `bash send/curl/send-template.sh "#1234"` |
| Node.js 18+ | `node send/node/send-text.js "Olá"` | `node send/node/send-template.js "#1234"` |
| Python | `python send/python/send_text.py "Olá"` | `python send/python/send_template.py "#1234"` |
| PHP 8 | `php send/php/send-text.php "Olá"` | `php send/php/send-template.php "#1234"` |

O Python precisa de `pip install -r send/python/requirements.txt`; o PHP precisa da extensão curl.

As duas chamadas, exatamente como a API recebe:

```sh
curl -X POST https://api.zapclaw.app/api/v1/send/text \
  -H "X-API-Key: $ZAPCLAW_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 8f14e45f-ea0e-4f1d-9a2b-1c0d3e5f7a90" \
  -d '{ "from": "15550001111", "to": "15550002222", "text": "Olá pela API do ZapClaw" }'

curl -X POST https://api.zapclaw.app/api/v1/send/template \
  -H "X-API-Key: $ZAPCLAW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "15550001111",
    "to": "15550002222",
    "templateName": "order_update",
    "language": "pt_BR",
    "components": [
      { "type": "body", "parameters": [ { "type": "text", "text": "#1234" } ] }
    ]
  }'
```

- **Texto** recebe `from`, `to`, `text` (até 4096 caracteres) e, se quiser, `previewUrl`
  e `replyTo` (o wamid de uma mensagem a citar). Uma mensagem livre só chega a um
  contato que escreveu para você nas últimas 24 horas.
- **Template** recebe `from`, `to`, `templateName`, `language`, `components` (no formato
  da Meta) e, se quiser, `replyTo`. Não depende da janela de 24 horas. O template
  precisa estar aprovado no número que envia; `GET /api/v1/send/templates` lista os
  disponíveis. Sem `language`, a API usa `pt_BR`, então mande sempre o idioma em que o
  template foi aprovado. Os exemplos de template leem o idioma de
  `ZAPCLAW_TEMPLATE_LANGUAGE` (padrão `en_US`) e o nome de `ZAPCLAW_TEMPLATE` (padrão
  `order_update`).

### O que volta

| Status | Significado | O que os exemplos fazem |
|---|---|---|
| `201` | Enviada. O corpo traz a mensagem com o `wamid`. | Mostram e saem com `0`. |
| `202` | **Entrega desconhecida.** A Meta informou uma falha que não descarta a entrega; a mensagem pode já estar no celular. | Mostram o aviso e a `Idempotency-Key` e saem com `2`. Nunca repita com uma chave nova. |
| `422` | A janela de 24 horas está fechada (`meta_code: 131047`): envie um template. Ou a `Idempotency-Key` já foi usada em outra requisição. | Mostram o erro e saem com `1`. |
| outros `4xx`, `5xx` | Recusada: o corpo diz o motivo em `error`, e em `meta_code` quando a recusa veio da Meta. | Mostram e saem com `1`. |

Todos os status estão na [referência de erros (em inglês)][docs-errors].

### Repetir sem enviar duas vezes

Todo exemplo manda o cabeçalho `Idempotency-Key`. Repetir a mesma requisição com a mesma
chave em até 10 minutos devolve a primeira resposta em vez de enviar uma segunda
mensagem. Os exemplos mostram a chave sempre que um envio não termina em `201`; para
repetir exatamente aquele envio, rode de novo com `ZAPCLAW_IDEMPOTENCY_KEY` igual à chave
mostrada. Mais na [documentação de idempotência (em inglês)][docs-idempotency].

## Coleção do Postman

Importe [`postman/zapclaw-api.postman_collection.json`](postman/zapclaw-api.postman_collection.json)
(no Postman: **Import** e escolha o arquivo), abra as **Variables** da coleção e preencha:

| Variável | Valor |
|---|---|
| `apiKey` | a sua chave de API; toda requisição a envia como `X-API-Key` pela autorização API Key da coleção |
| `from` | um dos seus números conectados, dígitos E.164 |
| `to` | um destinatário |
| `baseUrl` | `https://api.zapclaw.app` (já preenchida) |

A coleção tem uma pasta por área (Messages, Numbers, Media, Templates, Profile, Block,
QR Codes, Automation, Analytics) e todos os endpoints do
[`openapi.yaml`](postman/openapi.yaml), uma cópia da [especificação publicada][openapi].

Ela é gerada, então nunca fica diferente da especificação:

```sh
node postman/build-collection.js            # refaz a partir de postman/openapi.yaml
node postman/check-collection.js            # valida contra o openapi.yaml
node postman/check-collection.js --cross-check   # também compara o leitor de YAML com o js-yaml (via npx)
```

O gerador não tem dependências nem precisa de rede: ele lê o YAML com o
[`yaml-subset.js`](postman/yaml-subset.js), que cobre o que arquivos OpenAPI usam e para
com o número da linha diante de qualquer outra coisa. A verificação confirma que o
método e o caminho de cada requisição existem no `openapi.yaml` (lido por uma varredura
de linhas separada), que cada operação está na coleção uma vez e que cada corpo e cada
parâmetro são os que a especificação documenta. Para atualizar a especificação antes:

```sh
curl -o postman/openapi.yaml "https://zapclaw.app/openapi.yaml?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples"
```

## Rodar os testes

```sh
npm install                 # Express, para o exemplo de webhook em Node.js
npm test                    # testes em Node.js; também roda cada exemplo de envio contra um mock local da API
python -m unittest discover -s webhook-signature/python/tests -v
php webhook-signature/php/test.php
```

O `npm test` também roda os exemplos de envio em Python, PHP e curl quando o ambiente
deles está instalado (Python com `requests`, PHP com a extensão curl, bash com curl) e
pula os que não estão. Os testes do Flask são pulados sem o Flask
(`pip install -r webhook-signature/python/requirements.txt`). Nada chama a API real.

## Mais do ZapClaw

- [n8n-whatsapp-official-api](https://github.com/zapclaw/n8n-whatsapp-official-api): WhatsApp no n8n pela API oficial, com o ZapClaw ([guia][n8n])
- [chatwoot-zapclaw](https://github.com/zapclaw/chatwoot-zapclaw/blob/main/README.pt-BR.md): Chatwoot self-hosted com o número ainda no celular
- [migrate-to-whatsapp-official-api](https://github.com/zapclaw/migrate-to-whatsapp-official-api): migrar uma integração para a API oficial, com guias para [Evolution API][migrate-evolution], [Z-API][migrate-zapi] e [WAHA][migrate-waha]
- Guias: [a API oficial do WhatsApp com o ZapClaw][official], [API não oficial ou oficial][unofficial], [requisitos da Coexistência][coex], [comparação com a Evolution API][vs-evolution], [comparação com a Z-API][vs-zapi], e WhatsApp com [Make][make], [Typebot][typebot], [Dify][dify] e [Flowise][flowise]
- [Sobre o ZapClaw][about]

## Segurança

As issues daqui são públicas. Nunca cole nelas uma chave de API (`zc_live_...`), uma
chave de assinatura (`whsec_...`) ou um número de telefone real. A chave do fixture
é um valor de teste que não assina nada real. Veja o [SECURITY.md](SECURITY.md).

## Licença

MIT. Veja a [LICENSE](LICENSE).

Este repositório é mantido pelo ZapClaw e não tem vínculo nem endosso da Meta. WhatsApp
é uma marca da Meta Platforms, Inc.

[home]: https://zapclaw.app/pt/?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[register]: https://app.zapclaw.app/register?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[docs]: https://zapclaw.app/docs.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[docs-errors]: https://zapclaw.app/docs.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples#errors
[docs-idempotency]: https://zapclaw.app/docs.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples#idempotency
[openapi]: https://zapclaw.app/openapi.yaml?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[pricing]: https://zapclaw.app/pt/pricing.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[official]: https://zapclaw.app/pt/whatsapp-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[unofficial]: https://zapclaw.app/pt/unofficial-vs-official-whatsapp-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[coex]: https://zapclaw.app/pt/coexistence-requirements.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[vs-evolution]: https://zapclaw.app/pt/zapclaw-vs-evolution-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[vs-zapi]: https://zapclaw.app/pt/zapclaw-vs-z-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[migrate-evolution]: https://zapclaw.app/pt/migrate-evolution-api-to-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[migrate-zapi]: https://zapclaw.app/pt/migrate-z-api-to-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[migrate-waha]: https://zapclaw.app/pt/migrate-waha-to-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[n8n]: https://zapclaw.app/pt/n8n-whatsapp-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[make]: https://zapclaw.app/pt/make-whatsapp-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[typebot]: https://zapclaw.app/pt/typebot-whatsapp-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[dify]: https://zapclaw.app/pt/dify-whatsapp-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[flowise]: https://zapclaw.app/pt/flowise-whatsapp-official-api.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
[about]: https://zapclaw.app/pt/about.html?utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples
