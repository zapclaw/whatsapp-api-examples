'use strict';

/**
 * Runs every send example against a local mock of the ZapClaw API and checks
 * the request each one makes: method, path, headers and body, validated with
 * the same rules the API applies to POST /api/v1/send/text and
 * POST /api/v1/send/template. Then checks how each example reacts to a 201,
 * a 202 (delivery unknown) and a refusal.
 *
 * Languages whose runtime is not installed are skipped: Python needs the
 * requests package (set ZAPCLAW_TEST_PYTHON to pick an interpreter), PHP needs
 * the curl extension, and the curl examples need bash and curl.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

// Recipients that make the mock answer something other than 201.
const TO_SENT = '15550002222';
const TO_UNKNOWN = '15550000202';
const TO_WINDOW_CLOSED = '15550000422';

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

/** The validation the API runs on each route (express-validator rules). */
const ROUTES = {
  '/api/v1/send/text': {
    allowed: ['from', 'to', 'text', 'previewUrl', 'replyTo'],
    validate: (b) => {
      if (!isNonEmptyString(b.from)) return 'from is required';
      if (!isNonEmptyString(b.to)) return 'to is required';
      if (typeof b.text !== 'string' || b.text.length < 1 || b.text.length > 4096) {
        return 'text must be between 1 and 4096 characters';
      }
      if (b.previewUrl !== undefined && typeof b.previewUrl !== 'boolean') return 'previewUrl must be a boolean';
      if (b.replyTo !== undefined && !isNonEmptyString(b.replyTo)) return 'replyTo must be a message id';
      return null;
    },
  },
  '/api/v1/send/template': {
    allowed: ['from', 'to', 'templateName', 'language', 'components', 'replyTo'],
    validate: (b) => {
      if (!isNonEmptyString(b.from)) return 'from is required';
      if (!isNonEmptyString(b.to)) return 'to is required';
      if (!isNonEmptyString(b.templateName)) return 'templateName is required';
      if (b.language !== undefined && typeof b.language !== 'string') return 'language must be a string';
      if (b.components !== undefined && !Array.isArray(b.components)) return 'components must be an array';
      if (b.replyTo !== undefined && !isNonEmptyString(b.replyTo)) return 'replyTo must be a message id';
      return null;
    },
  },
};

const message = (b, overrides = {}) => ({
  id: '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
  direction: 'outbound',
  to: b.to,
  type: b.templateName ? 'template' : 'text',
  templateName: b.templateName || null,
  content: b.text || null,
  wamid: 'wamid.HBgLMTU1NTAwMDIyMjIVAgARGBI1',
  status: 'sent',
  errorMessage: null,
  sentAt: '2026-10-15T14:00:00.000Z',
  createdAt: '2026-10-15T14:00:00.000Z',
  ...overrides,
});

const startMockApi = async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        // left null: answered 400 below
      }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });

      const reply = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const route = ROUTES[req.url];
      if (req.method !== 'POST' || !route) return reply(404, { error: 'Not found' });
      if (req.headers['x-api-key'] !== 'zc_live_test_key') return reply(401, { error: 'Invalid API key' });
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        return reply(400, { error: 'Content-Type must be application/json' });
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'Invalid JSON' });
      const unknown = Object.keys(body).filter((key) => !route.allowed.includes(key));
      if (unknown.length) return reply(400, { error: `Unknown fields: ${unknown.join(', ')}` });
      const invalid = route.validate(body);
      if (invalid) return reply(400, { error: invalid });

      if (body.to === TO_UNKNOWN) {
        return reply(202, {
          message: message(body, { wamid: null, status: 'indeterminate', sentAt: null }),
          delivery: 'unknown',
          code: 'DELIVERY_INDETERMINATE',
          meta_code: 131000,
          warning: '(#131000) Something went wrong. The message may have been delivered and may not have been.',
        });
      }
      if (body.to === TO_WINDOW_CLOSED && !body.templateName) {
        return reply(422, {
          error: 'The 24-hour customer service window with this contact is closed. Send an approved template to reopen the conversation.',
          meta_code: 131047,
        });
      }
      return reply(201, { message: message(body) });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, baseUrl: `http://127.0.0.1:${server.address().port}` };
};

const run = (command, args, env) => new Promise((resolve) => {
  const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error) }));
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});

const works = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return !result.error && result.status === 0;
};

const findPython = () => {
  const candidates = [process.env.ZAPCLAW_TEST_PYTHON, 'python3', 'python'].filter(Boolean);
  return candidates.find((candidate) => works(candidate, ['-c', 'import requests'])) || null;
};

const python = findPython();
const php = works('php', ['-r', 'exit(extension_loaded("curl") ? 0 : 1);']) ? 'php' : null;
const bash = works('bash', ['-c', 'command -v curl >/dev/null']) ? 'bash' : null;

const RUNNERS = [
  { name: 'Node.js', command: process.execPath, text: ['send/node/send-text.js'], template: ['send/node/send-template.js'] },
  { name: 'Python', command: python, text: ['send/python/send_text.py'], template: ['send/python/send_template.py'], missing: 'Python with requests' },
  { name: 'PHP', command: php, text: ['send/php/send-text.php'], template: ['send/php/send-template.php'], missing: 'php with the curl extension' },
  { name: 'curl', command: bash, text: ['send/curl/send-text.sh'], template: ['send/curl/send-template.sh'], missing: 'bash and curl' },
];

const TEXT = 'Order #1234 is confirmed. Café "Lisboa", 10:30 \\ thanks 👋';

for (const runner of RUNNERS) {
  test(`${runner.name} examples`, { skip: runner.command ? false : `${runner.missing} not found` }, async (t) => {
    const api = await startMockApi();
    t.after(() => new Promise((resolve) => api.server.close(resolve)));
    const env = (to, extra = {}) => ({
      ZAPCLAW_BASE_URL: api.baseUrl,
      ZAPCLAW_API_KEY: 'zc_live_test_key',
      ZAPCLAW_FROM: '15550001111',
      ZAPCLAW_TO: to,
      ZAPCLAW_IDEMPOTENCY_KEY: '',
      ...extra,
    });
    const last = () => api.requests[api.requests.length - 1];
    const assertCommonHeaders = (request) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers['x-api-key'], 'zc_live_test_key');
      assert.match(request.headers['content-type'], /^application\/json/);
      assert.ok(isNonEmptyString(request.headers['idempotency-key']), 'Idempotency-Key header missing');
      assert.ok(request.headers['idempotency-key'].length <= 255);
    };

    await t.test('send text: 201', async () => {
      const result = await run(runner.command, [...runner.text, TEXT], env(TO_SENT));
      assert.equal(result.code, 0, result.stderr || result.stdout);
      const request = last();
      assert.equal(request.url, '/api/v1/send/text');
      assertCommonHeaders(request);
      assert.deepEqual(request.body, { from: '15550001111', to: TO_SENT, text: TEXT });
    });

    await t.test('send text: 202 delivery unknown exits 2', async () => {
      const before = api.requests.length;
      const result = await run(runner.command, [...runner.text, 'hi'], env(TO_UNKNOWN));
      assert.equal(result.code, 2, result.stderr || result.stdout);
      assert.equal(api.requests.length, before + 1, 'an example must not retry a 202 on its own');
      assert.match(result.stderr, /Idempotency-Key/);
    });

    await t.test('send text: a reused Idempotency-Key is sent as given', async () => {
      const result = await run(runner.command, [...runner.text, 'hi'], env(TO_SENT, { ZAPCLAW_IDEMPOTENCY_KEY: 'retry-key-123' }));
      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.equal(last().headers['idempotency-key'], 'retry-key-123');
    });

    await t.test('send text: 422 window closed exits 1', async () => {
      const result = await run(runner.command, [...runner.text, 'hi'], env(TO_WINDOW_CLOSED));
      assert.equal(result.code, 1, result.stderr || result.stdout);
      assert.match(result.stderr, /422/);
    });

    await t.test('send template: 201', async () => {
      const result = await run(runner.command, [...runner.template, '#1234 "A"'], env(TO_WINDOW_CLOSED, {
        ZAPCLAW_TEMPLATE: 'order_update',
        ZAPCLAW_TEMPLATE_LANGUAGE: 'en_US',
      }));
      assert.equal(result.code, 0, result.stderr || result.stdout);
      const request = last();
      assert.equal(request.url, '/api/v1/send/template');
      assertCommonHeaders(request);
      assert.deepEqual(request.body, {
        from: '15550001111',
        to: TO_WINDOW_CLOSED,
        templateName: 'order_update',
        language: 'en_US',
        components: [{ type: 'body', parameters: [{ type: 'text', text: '#1234 "A"' }] }],
      });
    });

    await t.test('missing API key: exits 1 without calling the API', async () => {
      const before = api.requests.length;
      const result = await run(runner.command, [...runner.text, 'hi'], env(TO_SENT, { ZAPCLAW_API_KEY: '' }));
      assert.equal(result.code, 1);
      assert.equal(api.requests.length, before);
    });
  });
}
