#!/usr/bin/env node
'use strict';

/**
 * Validates postman/zapclaw-api.postman_collection.json against
 * postman/openapi.yaml.
 *
 *   node postman/check-collection.js                 offline checks
 *   node postman/check-collection.js --cross-check   also compares yaml-subset.js with
 *                                                    js-yaml (downloads it through npx once)
 *
 * The checks:
 *   1. the collection is valid JSON in the v2.1.0 format, with {{baseUrl}} and
 *      the X-API-Key header (as {{apiKey}}) defined as collection variables
 *   2. every request's method and path exist in openapi.yaml, read with a
 *      plain line scan that does not share code with the generator, and every
 *      operation in openapi.yaml is in the collection exactly once
 *   3. every JSON or form body only holds fields the operation documents, and
 *      holds all of its required ones; path and query parameters likewise
 *
 * Exits 0 when everything passes, 1 otherwise.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { parseYaml } = require('./yaml-subset');
const { deref, DEFAULT_SPEC, DEFAULT_OUT, SCHEMA_URL } = require('./build-collection');

const JS_YAML = 'js-yaml@4.3.2';
const HTTP_METHODS = ['GET', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'TRACE'];

/**
 * The operations of an OpenAPI file, read line by line: a path is a key
 * indented by two spaces under "paths:", a method a key indented by four.
 * @returns {Set<string>} entries such as "POST /api/v1/send/text"
 */
const scanOperations = (yamlText) => {
  const operations = new Set();
  let inPaths = false;
  let currentPath = null;
  for (const rawLine of yamlText.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    if (/^\S/.test(line)) break;
    const pathMatch = /^ {2}(["']?)(\/[^"']*)\1:\s*$/.exec(line);
    if (pathMatch) {
      [, , currentPath] = pathMatch;
      continue;
    }
    const methodMatch = /^ {4}(get|put|post|delete|patch|options|head|trace):\s*$/.exec(line);
    if (methodMatch && currentPath) operations.add(`${methodMatch[1].toUpperCase()} ${currentPath}`);
  }
  return operations;
};

/** Every request in a collection, with the folder it sits in. */
const requestsOf = (items, folder = '') => items.flatMap((item) => (Array.isArray(item.item)
  ? requestsOf(item.item, item.name)
  : [{ folder, item }]));

/**
 * Runs every offline check.
 * @returns {string[]} the problems found, empty when the collection is valid
 */
const checkCollection = ({ collectionText, yamlText }) => {
  const problems = [];
  let collection;
  try {
    collection = JSON.parse(collectionText);
  } catch (error) {
    return [`The collection is not valid JSON: ${error.message}`];
  }

  // 1. Format and collection variables.
  const info = collection.info || {};
  if (info.schema !== SCHEMA_URL) problems.push(`info.schema is ${info.schema}, expected ${SCHEMA_URL}`);
  if (typeof info.name !== 'string' || !info.name) problems.push('info.name is missing');
  if (!Array.isArray(collection.item) || collection.item.length === 0) problems.push('the collection has no items');
  const variables = new Map((collection.variable || []).map((v) => [v.key, v]));
  for (const key of ['baseUrl', 'apiKey', 'from', 'to']) {
    if (!variables.has(key)) problems.push(`collection variable "${key}" is missing`);
  }
  if (!/^https:\/\//.test(String((variables.get('baseUrl') || {}).value))) {
    problems.push('the baseUrl variable is not an https URL');
  }
  const auth = collection.auth || {};
  const authValue = (name) => ((auth.apikey || []).find((entry) => entry.key === name) || {}).value;
  if (auth.type !== 'apikey' || authValue('key') !== 'X-API-Key' || authValue('value') !== '{{apiKey}}'
      || authValue('in') !== 'header') {
    problems.push('the collection auth must be an API key sent as the X-API-Key header with the value {{apiKey}}');
  }

  // 2. Every request exists in the spec; every operation is in the collection once.
  const specOperations = scanOperations(yamlText);
  if (specOperations.size === 0) problems.push('no operations found in openapi.yaml');
  const spec = parseYaml(yamlText);
  const seen = new Map();

  for (const { folder, item } of requestsOf(collection.item || [])) {
    const label = `${folder} / ${item.name}`;
    const request = item.request;
    if (!request || typeof request !== 'object') {
      problems.push(`${label}: no request`);
      continue;
    }
    const method = String(request.method || '').toUpperCase();
    if (!HTTP_METHODS.includes(method)) problems.push(`${label}: unknown method ${request.method}`);
    const url = request.url || {};
    if (!Array.isArray(url.host) || url.host.length !== 1 || url.host[0] !== '{{baseUrl}}') {
      problems.push(`${label}: url.host must be ["{{baseUrl}}"]`);
    }
    if (!Array.isArray(url.path)) {
      problems.push(`${label}: url.path is missing`);
      continue;
    }
    const postmanPath = `/${url.path.join('/')}`;
    const specPath = postmanPath.replace(/\/:([^/]+)/g, '/{$1}');
    const operationKey = `${method} ${specPath}`;
    if (typeof url.raw !== 'string' || url.raw.split('?')[0] !== `{{baseUrl}}${postmanPath}`) {
      problems.push(`${label}: url.raw ${url.raw} does not match its path ${postmanPath}`);
    }
    if (!specOperations.has(operationKey)) {
      problems.push(`${label}: ${operationKey} is not in openapi.yaml`);
      continue;
    }
    seen.set(operationKey, (seen.get(operationKey) || 0) + 1);

    // 3. Parameters and body against the operation.
    const pathItem = spec.paths[specPath];
    const operation = pathItem[method.toLowerCase()];
    const parameters = [...(pathItem.parameters || []), ...(operation.parameters || [])].map((p) => deref(spec, p));

    const pathParameters = parameters.filter((p) => p.in === 'path').map((p) => p.name).sort();
    const pathVariables = (url.variable || []).map((v) => v.key).sort();
    const pathSegments = url.path.filter((s) => s.startsWith(':')).map((s) => s.slice(1)).sort();
    if (JSON.stringify(pathParameters) !== JSON.stringify(pathVariables)
        || JSON.stringify(pathParameters) !== JSON.stringify(pathSegments)) {
      problems.push(`${label}: path variables ${pathVariables} do not match the spec's ${pathParameters}`);
    }

    const queryParameters = parameters.filter((p) => p.in === 'query');
    for (const entry of url.query || []) {
      if (!queryParameters.some((p) => p.name === entry.key)) {
        problems.push(`${label}: query parameter "${entry.key}" is not documented`);
      }
    }
    for (const parameter of queryParameters.filter((p) => p.required)) {
      const entry = (url.query || []).find((q) => q.key === parameter.name);
      if (!entry || entry.disabled) problems.push(`${label}: required query parameter "${parameter.name}" is missing or disabled`);
    }

    const headerNames = (request.header || []).map((h) => String(h.key).toLowerCase());
    for (const parameter of parameters.filter((p) => p.in === 'header')) {
      if (!headerNames.includes(parameter.name.toLowerCase())) {
        problems.push(`${label}: header "${parameter.name}" is missing`);
      }
    }

    const requestBody = deref(spec, operation.requestBody);
    const content = (requestBody && requestBody.content) || {};
    const body = request.body;
    if (content['application/json']) {
      if (!body || body.mode !== 'raw') {
        problems.push(`${label}: a JSON body is expected`);
        continue;
      }
      if (!headerNames.includes('content-type')) problems.push(`${label}: Content-Type header is missing`);
      let parsed;
      try {
        parsed = JSON.parse(body.raw);
      } catch (error) {
        problems.push(`${label}: the body is not valid JSON (${error.message})`);
        continue;
      }
      const schema = deref(spec, content['application/json'].schema);
      const properties = Object.keys(schema.properties || {});
      for (const key of Object.keys(parsed)) {
        if (!properties.includes(key)) problems.push(`${label}: body field "${key}" is not documented`);
      }
      for (const key of schema.required || []) {
        if (!(key in parsed)) problems.push(`${label}: required body field "${key}" is missing`);
      }
    } else if (content['multipart/form-data']) {
      if (!body || body.mode !== 'formdata') {
        problems.push(`${label}: a form-data body is expected`);
        continue;
      }
      const schema = deref(spec, content['multipart/form-data'].schema);
      const properties = Object.keys(schema.properties || {});
      const keys = body.formdata.map((f) => f.key);
      for (const key of keys) {
        if (!properties.includes(key)) problems.push(`${label}: form field "${key}" is not documented`);
      }
      for (const key of schema.required || []) {
        if (!keys.includes(key)) problems.push(`${label}: required form field "${key}" is missing`);
      }
    } else if (body) {
      problems.push(`${label}: has a body the spec does not document`);
    }
  }

  for (const operation of specOperations) {
    const count = seen.get(operation) || 0;
    if (count !== 1) problems.push(`${operation} appears ${count} times in the collection`);
  }
  return problems;
};

/** Deep comparison that also compares key order. Returns the first difference, or null. */
const firstDifference = (a, b, where = '') => {
  if (Array.isArray(a) !== Array.isArray(b) || typeof a !== typeof b || (a === null) !== (b === null)) {
    return `${where || '/'}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  if (a && typeof a === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.join('\n') !== keysB.join('\n')) return `${where || '/'}: keys [${keysA}] vs [${keysB}]`;
    for (const key of keysA) {
      const difference = firstDifference(a[key], b[key], `${where}/${key}`);
      if (difference) return difference;
    }
    return null;
  }
  return Object.is(a, b) ? null : `${where || '/'}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
};

/** Reads the spec with js-yaml (through npx) and compares it with yaml-subset.js. */
const crossCheck = (specPath) => {
  const output = execSync(`npx --yes ${JS_YAML} "${specPath}"`, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const viaJsYaml = JSON.parse(output);
  const viaSubset = JSON.parse(JSON.stringify(parseYaml(fs.readFileSync(specPath, 'utf8'))));
  return firstDifference(viaSubset, viaJsYaml);
};

const main = () => {
  const collectionPath = DEFAULT_OUT;
  const specPath = DEFAULT_SPEC;
  const problems = checkCollection({
    collectionText: fs.readFileSync(collectionPath, 'utf8'),
    yamlText: fs.readFileSync(specPath, 'utf8'),
  });
  const requests = requestsOf(JSON.parse(fs.readFileSync(collectionPath, 'utf8')).item).length;
  const operations = scanOperations(fs.readFileSync(specPath, 'utf8')).size;

  if (process.argv.includes('--cross-check')) {
    const difference = crossCheck(specPath);
    if (difference) problems.push(`yaml-subset.js and ${JS_YAML} disagree at ${difference}`);
    else console.log(`yaml-subset.js reads ${path.basename(specPath)} exactly as ${JS_YAML} does.`);
  }

  if (problems.length) {
    console.error(`${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`OK: ${requests} requests, all ${operations} operations of ${path.basename(specPath)}, bodies and parameters as documented.`);
};

if (require.main === module) main();

module.exports = { checkCollection, scanOperations, firstDifference };
