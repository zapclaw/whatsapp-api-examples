#!/usr/bin/env node
'use strict';

/**
 * Builds the Postman collection (format v2.1.0) from postman/openapi.yaml.
 *
 *   node postman/build-collection.js           writes postman/zapclaw-api.postman_collection.json
 *   node postman/build-collection.js --check   exits 1 if that file is out of date
 *
 * Options: --spec <file> reads another copy of the spec, --out <file> writes
 * somewhere else. No dependencies and no network: the YAML is read with
 * yaml-subset.js.
 *
 * What the generator decides, so the output is predictable:
 *   - one folder per tag, in the spec's tag order; requests in path order
 *   - the API key goes in a collection-level API Key auth (header X-API-Key,
 *     value {{apiKey}}); the server URL becomes {{baseUrl}}
 *   - every "from" and "to" field or query parameter is {{from}} / {{to}}
 *   - a JSON body holds the required fields plus the optional ones the spec
 *     gives an example for (a truncated example ending in "..." is left out),
 *     then BODY_ADJUSTMENTS below, and nothing the spec does not document
 *   - optional query parameters are present but disabled
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { parseYaml } = require('./yaml-subset');

const DEFAULT_SPEC = path.join(__dirname, 'openapi.yaml');
const DEFAULT_OUT = path.join(__dirname, 'zapclaw-api.postman_collection.json');
const SCHEMA_URL = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const UTM = 'utm_source=github&utm_medium=referral&utm_campaign=whatsapp-api-examples';
const REPO_URL = 'https://github.com/zapclaw/whatsapp-api-examples';
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

/**
 * Where the spec's own examples, taken together, would not make a request
 * that works as is. Every field named here must exist in the operation's
 * schema: check-collection.js refuses the collection otherwise.
 */
const BODY_ADJUSTMENTS = {
  // The API defaults the language to pt_BR; a template is sent in the
  // language it was approved in, so the example names one.
  sendTemplate: {
    set: {
      language: 'en_US',
      components: [{ type: 'body', parameters: [{ type: 'text', text: '#1234' }] }],
    },
  },
  // link and mediaId are exclusive: keep the link.
  sendMedia: { drop: ['mediaId'] },
  // headerMediaUrl only means something with a media headerFormat.
  createTemplate: { drop: ['headerMediaUrl'], set: { language: 'en_US' } },
  // "from" is accepted and ignored here; an edit needs a field to change.
  editTemplate: {
    drop: ['from'],
    set: {
      bodyText: 'Hi {{1}}, your order {{2}} is on its way.',
      variableExamples: { 1: 'Ana', 2: 'A-123' },
    },
  },
  recreateTemplate: { set: { bodyText: 'Your order has shipped.' } },
  // The API wants at least one field besides "from".
  updateAutomation: { set: { enableWelcomeMessage: true } },
};

const VARIABLE_FIELDS = { from: '{{from}}', to: '{{to}}' };

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** Follows a local "#/..." reference. */
const resolveRef = (spec, ref) => {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) {
    throw new Error(`Only local references are supported: ${ref}`);
  }
  return ref.slice(2).split('/').reduce((node, part) => {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === undefined || node === null || !(key in node)) throw new Error(`Unresolvable reference: ${ref}`);
    return node[key];
  }, spec);
};

const deref = (spec, node) => {
  let current = node;
  const seen = new Set();
  while (current && typeof current === 'object' && typeof current.$ref === 'string') {
    if (seen.has(current.$ref)) throw new Error(`Circular reference: ${current.$ref}`);
    seen.add(current.$ref);
    current = resolveRef(spec, current.$ref);
  }
  return current;
};

const isPlaceholder = (example) => typeof example === 'string' && example.endsWith('...');

/** An example value for a schema: its example, default or first enum value, else a blank of its type. */
const exampleFor = (spec, schemaNode, depth = 0) => {
  const schema = deref(spec, schemaNode);
  if (!schema || typeof schema !== 'object' || depth > 10) return null;
  if (schema.example !== undefined) return clone(schema.example);
  if (schema.default !== undefined) return clone(schema.default);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return clone(schema.enum[0]);
  switch (schema.type) {
    case 'object':
      return objectExample(spec, schema, depth, false);
    case 'array': {
      const item = exampleFor(spec, schema.items, depth + 1);
      return item === null || item === '' ? [] : [item];
    }
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'string':
      return '';
    default:
      return null;
  }
};

/**
 * Required properties, plus optional ones the spec gives a usable example for.
 * At the top level of a request body, "from" and "to" become variables.
 */
function objectExample(spec, schema, depth, topLevel) {
  const required = new Set(schema.required || []);
  const result = {};
  for (const [name, propertyNode] of Object.entries(schema.properties || {})) {
    const property = deref(spec, propertyNode) || {};
    const hasUsableExample = property.example !== undefined && !isPlaceholder(property.example);
    if (!required.has(name) && !hasUsableExample) continue;
    if (topLevel && VARIABLE_FIELDS[name] && property.type === 'string') {
      result[name] = VARIABLE_FIELDS[name];
    } else {
      result[name] = exampleFor(spec, property, depth + 1);
    }
  }
  return result;
}

const requestBodyExample = (spec, operation, schema) => {
  const body = objectExample(spec, schema, 0, true);
  const adjustment = BODY_ADJUSTMENTS[operation.operationId] || {};
  for (const name of adjustment.drop || []) delete body[name];
  for (const [name, value] of Object.entries(adjustment.set || {})) body[name] = clone(value);
  return body;
};

/** A UUID derived from a name, so every build gives the collection the same id. */
const stableUuid = (name) => {
  const hex = crypto.createHash('sha256').update(name).digest('hex');
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** Site links in text taken from the spec get this repository's campaign tags, like every other link here. */
const tagSiteLinks = (text) => text.replace(/https:\/\/(?:app\.)?zapclaw\.app\/[^\s)\]"'<>`]*/g, (match) => {
  const trailing = /[.,;:!?]+$/.exec(match);
  const url = trailing ? match.slice(0, -trailing[0].length) : match;
  if (url.includes('utm_source=')) return match;
  const [base, hash] = url.split('#');
  const tagged = `${base}${base.includes('?') ? '&' : '?'}${UTM}${hash === undefined ? '' : `#${hash}`}`;
  return tagged + (trailing ? trailing[0] : '');
});

const trimText = (text) => (typeof text === 'string' ? tagSiteLinks(text.trim()) : '');

const parametersOf = (spec, pathItem, operation) => {
  const byKey = new Map();
  for (const node of [...(pathItem.parameters || []), ...(operation.parameters || [])]) {
    const parameter = deref(spec, node);
    byKey.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  return [...byKey.values()];
};

/** A parameter's own example, default or first enum value; blank when the spec gives none. */
const parameterValue = (spec, parameter) => {
  if (VARIABLE_FIELDS[parameter.name] && parameter.in === 'query') return VARIABLE_FIELDS[parameter.name];
  if (parameter.in === 'header' && parameter.name === 'Idempotency-Key') return '{{$guid}}';
  const schema = deref(spec, parameter.schema) || {};
  const candidates = [parameter.example, schema.example, schema.default, Array.isArray(schema.enum) ? schema.enum[0] : undefined];
  const value = candidates.find((candidate) => candidate !== undefined && candidate !== null);
  return value === undefined ? '' : String(value);
};

const buildRequest = (spec, apiPath, method, pathItem, operation) => {
  const parameters = parametersOf(spec, pathItem, operation);
  const header = [];
  const notes = [];
  let body;

  const requestBody = deref(spec, operation.requestBody);
  const content = (requestBody && requestBody.content) || {};
  if (content['application/json']) {
    const schema = deref(spec, content['application/json'].schema);
    const example = requestBodyExample(spec, operation, schema);
    header.push({ key: 'Content-Type', value: 'application/json' });
    body = {
      mode: 'raw',
      raw: JSON.stringify(example, null, 2),
      options: { raw: { language: 'json' } },
    };
    if (/\{\{\d+\}\}/.test(body.raw)) {
      notes.push('The {{1}} and {{2}} in the body are WhatsApp template variables, not Postman variables: leave them as they are, and do not define Postman variables named 1 or 2.');
    }
  } else if (content['multipart/form-data']) {
    const schema = deref(spec, content['multipart/form-data'].schema);
    body = {
      mode: 'formdata',
      formdata: Object.entries(schema.properties || {}).map(([name, propertyNode]) => {
        const property = deref(spec, propertyNode) || {};
        const description = trimText(property.description);
        if (property.format === 'binary') {
          return { key: name, type: 'file', src: [], ...(description && { description }) };
        }
        const value = VARIABLE_FIELDS[name] || String(exampleFor(spec, property) ?? '');
        return { key: name, value, type: 'text', ...(description && { description }) };
      }),
    };
  }

  for (const parameter of parameters.filter((p) => p.in === 'header')) {
    const description = trimText(parameter.description);
    header.push({
      key: parameter.name,
      value: parameterValue(spec, parameter),
      ...(description && {
        description: parameter.name === 'Idempotency-Key'
          ? `${description} In Postman, {{$guid}} makes a new key on every send. To be able to retry one send without a duplicate, replace it with a fixed value before the first attempt and keep that value for the retries.`
          : description,
      }),
    });
  }

  const pathVariables = parameters.filter((p) => p.in === 'path');
  const query = parameters.filter((p) => p.in === 'query').map((parameter) => {
    const description = trimText(parameter.description);
    return {
      key: parameter.name,
      value: parameterValue(spec, parameter),
      ...(description && { description }),
      ...(parameter.required ? {} : { disabled: true }),
    };
  });

  const segments = apiPath.split('/').filter(Boolean).map((segment) => segment.replace(/^\{(.+)\}$/, ':$1'));
  const enabledQuery = query.filter((q) => !q.disabled).map((q) => `${q.key}=${q.value}`).join('&');
  const url = {
    raw: `{{baseUrl}}/${segments.join('/')}${enabledQuery ? `?${enabledQuery}` : ''}`,
    host: ['{{baseUrl}}'],
    path: segments,
    ...(query.length && { query }),
    ...(pathVariables.length && {
      variable: pathVariables.map((parameter) => {
        const description = trimText(parameter.description);
        return { key: parameter.name, value: '', ...(description && { description }) };
      }),
    }),
  };

  const description = [trimText(operation.description) || trimText(operation.summary), ...notes]
    .filter(Boolean)
    .join('\n\n');

  return {
    name: operation.summary || operation.operationId,
    request: {
      method: method.toUpperCase(),
      header,
      ...(body && { body }),
      url,
      description,
    },
    response: [],
  };
};

/**
 * @param {object} spec the parsed OpenAPI document
 * @returns {object} the Postman collection
 */
const buildCollection = (spec) => {
  const scheme = Object.values((spec.components && spec.components.securitySchemes) || {})
    .find((s) => s.type === 'apiKey' && s.in === 'header');
  if (!scheme) throw new Error('The spec has no header API key security scheme.');
  const server = spec.servers && spec.servers[0] && spec.servers[0].url;
  if (!server) throw new Error('The spec has no server URL.');

  const folders = new Map((spec.tags || []).map((tag) => [tag.name, { tag, items: [] }]));
  for (const [apiPath, pathItem] of Object.entries(spec.paths || {})) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;
      const tagName = (operation.tags && operation.tags[0]) || 'Other';
      if (!folders.has(tagName)) folders.set(tagName, { tag: { name: tagName }, items: [] });
      folders.get(tagName).items.push(buildRequest(spec, apiPath, method, pathItem, operation));
    }
  }

  const description = [
    `Every endpoint of the ZapClaw REST API, generated from its OpenAPI document (version ${spec.info.version}).`,
    'Before the first request, open this collection\'s **Variables** and set `apiKey` (create one in the ZapClaw dashboard under **API Keys**), `from` (one of your connected numbers, E.164 digits) and `to` (a recipient). Every request sends the key in the `X-API-Key` header through the collection\'s API Key authorization.',
    `Reference: [API and webhook docs](https://zapclaw.app/docs.html?${UTM}). No account yet: [start free](https://app.zapclaw.app/register?${UTM}).`,
    `Generated by \`postman/build-collection.js\` in [zapclaw/whatsapp-api-examples](${REPO_URL}). Edit the generator, not this file.`,
    '## About the API',
    trimText(spec.info.description),
  ].join('\n\n');

  return {
    info: {
      _postman_id: stableUuid('zapclaw-api-postman-collection'),
      name: spec.info.title,
      description,
      schema: SCHEMA_URL,
      version: spec.info.version,
    },
    auth: {
      type: 'apikey',
      apikey: [
        { key: 'key', value: scheme.name, type: 'string' },
        { key: 'value', value: '{{apiKey}}', type: 'string' },
        { key: 'in', value: 'header', type: 'string' },
      ],
    },
    variable: [
      { key: 'baseUrl', value: server, type: 'string', description: 'ZapClaw API base URL.' },
      { key: 'apiKey', value: '', type: 'string', description: 'Your ZapClaw API key (zc_live_...). Shown once, when you create it in the dashboard.' },
      { key: 'from', value: '', type: 'string', description: 'One of your connected WhatsApp numbers, E.164 digits.' },
      { key: 'to', value: '', type: 'string', description: 'The recipient: E.164 digits, or the user_id (BSUID) from an inbound webhook.' },
    ],
    item: [...folders.values()]
      .filter((folder) => folder.items.length > 0)
      .map(({ tag, items }) => ({
        name: tag.name,
        ...(trimText(tag.description) && { description: trimText(tag.description) }),
        item: items,
      })),
  };
};

const serializeCollection = (collection) => JSON.stringify(collection, null, 2) + '\n';

const argValue = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};

const main = () => {
  const specPath = path.resolve(argValue('--spec') || DEFAULT_SPEC);
  const outPath = path.resolve(argValue('--out') || DEFAULT_OUT);
  const spec = parseYaml(fs.readFileSync(specPath, 'utf8'));
  const output = serializeCollection(buildCollection(spec));

  if (process.argv.includes('--check')) {
    const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null;
    if (current !== output) {
      console.error(`${path.relative(process.cwd(), outPath)} is out of date. Run: node postman/build-collection.js`);
      process.exit(1);
    }
    console.log('Collection is up to date.');
    return;
  }

  fs.writeFileSync(outPath, output);
  const requests = JSON.parse(output).item.reduce((n, folder) => n + folder.item.length, 0);
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}: ${requests} requests from ${path.relative(process.cwd(), specPath)} (${spec.info.title} ${spec.info.version}).`);
};

if (require.main === module) main();

module.exports = {
  buildCollection, serializeCollection, deref, BODY_ADJUSTMENTS, DEFAULT_SPEC, DEFAULT_OUT, SCHEMA_URL,
};
