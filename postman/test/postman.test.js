'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { parseYaml, YamlSubsetError } = require('../yaml-subset');
const {
  buildCollection, serializeCollection, DEFAULT_SPEC, DEFAULT_OUT, SCHEMA_URL,
} = require('../build-collection');
const { checkCollection, scanOperations } = require('../check-collection');

const yamlText = fs.readFileSync(DEFAULT_SPEC, 'utf8');
const collectionText = fs.readFileSync(DEFAULT_OUT, 'utf8');

// Expected values below are what js-yaml returns for the same input, except
// for timestamps: js-yaml turns them into dates, this reader keeps the text.
const CASES = {
  'folded scalar: lines fold into spaces, blank lines into breaks': [
    'a: >\n  one\n  two\n\n  three\n\n\n  four\nb: x\n',
    { a: 'one two\nthree\n\nfour\n', b: 'x' },
  ],
  'folded scalar: more indented lines keep their breaks': [
    'a: >\n  p1\n    code\n  p2\n',
    { a: 'p1\n  code\np2\n' },
  ],
  'literal scalar with strip chomping': [
    'a: |-\n  line 1\n    indented\n  line 3\n\n\nb: 1\n',
    { a: 'line 1\n  indented\nline 3', b: 1 },
  ],
  'literal scalar with keep chomping': [
    'a: |+\n  x\n\nb: 2\n',
    { a: 'x\n\n', b: 2 },
  ],
  'literal scalar at the end of the file': [
    'a: |\n  x\n  y',
    { a: 'x\ny\n' },
  ],
  'flow collections': [
    "a: { b: [1, \"two\", 'thr''ee'], c: { d: null }, e: Plain text here. }\nf: [ ]\ng: {}\n",
    { a: { b: [1, 'two', "thr'ee"], c: { d: null }, e: 'Plain text here.' }, f: [], g: {} },
  ],
  'flow collection across lines': [
    'a: [\n  one,\n  "two, three",\n]\n',
    { a: ['one', 'two, three'] },
  ],
  'sequences: compact mappings, nested sequences, same indentation as the key': [
    'list:\n- name: a\n  value: 1\n- - x\n  - y\n- plain\nother: true\n',
    { list: [{ name: 'a', value: 1 }, ['x', 'y'], 'plain'], other: true },
  ],
  'scalars resolve as in the YAML 1.2 core schema': [
    [
      'n: ~', 't: True', 'i: -12', 'f: 1.5e3', 'v: 1.3.0', 'd: 2026-05-21T14:00:00Z',
      'q: "\\u00e9\\t\\"x\\""', "s: 'it''s'", 'h: "#not a comment"', 'c: value # comment',
      'url: https://x.test/#frag', 'e:', '"201": quoted key', '',
    ].join('\n'),
    {
      n: null, t: true, i: -12, f: 1500, v: '1.3.0', d: '2026-05-21T14:00:00Z',
      q: 'é\t"x"', s: "it's", h: '#not a comment', c: 'value',
      url: 'https://x.test/#frag', e: null, 201: 'quoted key',
    },
  ],
  'plain scalar continued on the next lines': [
    'a: first\n  second\n\n  third\nb: 1\n',
    { a: 'first second\nthird', b: 1 },
  ],
  'comments and blank lines between entries': [
    '# head\na: 1\n\n  # indented comment\nb:\n  # before the child\n  c: 2\n',
    { a: 1, b: { c: 2 } },
  ],
};

for (const [name, [source, expected]] of Object.entries(CASES)) {
  test(`yaml-subset: ${name}`, () => {
    assert.deepEqual(parseYaml(source), expected);
  });
}

test('yaml-subset: a key named __proto__ stays plain data', () => {
  const value = parseYaml('__proto__:\n  polluted: true\n');
  assert.deepEqual(Object.keys(value), ['__proto__']);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
});

const UNSUPPORTED = {
  anchor: 'a: &x 1\n',
  alias: 'a: 1\nb: *x\n',
  tag: 'a: !!str 1\n',
  'tab indentation': 'a:\n\tb: 1\n',
  'duplicated key': 'a: 1\na: 2\n',
  'several documents': '---\na: 1\n---\nb: 2\n',
  'explicit block indentation': 'a: |2\n  x\n',
  'quoted scalar across lines': 'a: "x\n  y"\n',
  'merge key': '<<: { a: 1 }\n',
  'complex key': '? a\n: b\n',
  'plain value with ": " inside': 'a: b: c\n',
  'hexadecimal number': 'a: 0x1F\n',
  'bad indentation': 'a:\n    b: 1\n  c: 2\n',
};

for (const [name, source] of Object.entries(UNSUPPORTED)) {
  test(`yaml-subset: refuses ${name} with a line number`, () => {
    assert.throws(() => parseYaml(source), (error) => error instanceof YamlSubsetError && /line \d+/.test(error.message));
  });
}

test('openapi.yaml reads the same with CRLF line endings and a byte order mark', () => {
  const crlf = '\uFEFF' + yamlText.replace(/\r?\n/g, '\r\n');
  assert.deepEqual(parseYaml(crlf), parseYaml(yamlText));
});

test('the committed collection is what build-collection.js produces', () => {
  const built = serializeCollection(buildCollection(parseYaml(yamlText)));
  assert.equal(collectionText, built, 'out of date: run node postman/build-collection.js');
});

test('the collection passes every check against openapi.yaml', () => {
  assert.deepEqual(checkCollection({ collectionText, yamlText }), []);
});

test('the collection is v2.1.0 with baseUrl and apiKey as variables and X-API-Key as its auth', () => {
  const collection = JSON.parse(collectionText);
  assert.equal(collection.info.schema, SCHEMA_URL);
  const variables = Object.fromEntries(collection.variable.map((v) => [v.key, v.value]));
  assert.equal(variables.baseUrl, 'https://api.zapclaw.app');
  assert.equal(variables.apiKey, '');
  assert.equal(collection.auth.type, 'apikey');
  assert.deepEqual(collection.auth.apikey, [
    { key: 'key', value: 'X-API-Key', type: 'string' },
    { key: 'value', value: '{{apiKey}}', type: 'string' },
    { key: 'in', value: 'header', type: 'string' },
  ]);
});

test('every operation in openapi.yaml is a request in the collection', () => {
  const collection = JSON.parse(collectionText);
  const requests = collection.item.flatMap((folder) => folder.item);
  assert.equal(requests.length, scanOperations(yamlText).size);
  assert.equal(scanOperations(yamlText).size, 35);
});

test('the send text and send template requests match the API', () => {
  const requests = JSON.parse(collectionText).item.flatMap((folder) => folder.item);
  const find = (raw, method) => requests.find((r) => r.request.url.raw === raw && r.request.method === method).request;
  const text = find('{{baseUrl}}/api/v1/send/text', 'POST');
  assert.deepEqual(JSON.parse(text.body.raw), { from: '{{from}}', to: '{{to}}', text: 'Hello from ZapClaw' });
  const template = find('{{baseUrl}}/api/v1/send/template', 'POST');
  assert.deepEqual(Object.keys(JSON.parse(template.body.raw)), ['from', 'to', 'templateName', 'language', 'components']);
});

const mutate = (change) => {
  const collection = JSON.parse(collectionText);
  change(collection);
  return checkCollection({ collectionText: JSON.stringify(collection), yamlText });
};

test('the check catches a request whose path is not in the spec', () => {
  const problems = mutate((c) => { c.item[0].item[0].request.url.path.push('extra'); });
  assert.ok(problems.some((p) => /not in openapi\.yaml/.test(p)), problems.join('\n'));
});

test('the check catches an undocumented body field and a missing required one', () => {
  const problems = mutate((c) => {
    const { request } = c.item[0].item[0];
    const body = JSON.parse(request.body.raw);
    delete body.text;
    body.message = 'hi';
    request.body.raw = JSON.stringify(body);
  });
  assert.ok(problems.some((p) => /"message" is not documented/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => /required body field "text"/.test(p)), problems.join('\n'));
});

test('the check catches a missing operation and invalid JSON', () => {
  assert.ok(mutate((c) => { c.item[0].item.shift(); }).some((p) => /POST \/api\/v1\/send\/text appears 0 times/.test(p)));
  assert.match(checkCollection({ collectionText: '{ nope', yamlText })[0], /not valid JSON/);
});

test('the check catches a missing apiKey variable or a different auth header', () => {
  assert.ok(mutate((c) => { c.variable = c.variable.filter((v) => v.key !== 'apiKey'); }).some((p) => /"apiKey" is missing/.test(p)));
  assert.ok(mutate((c) => { c.auth.apikey[0].value = 'Authorization'; }).some((p) => /X-API-Key/.test(p)));
});
