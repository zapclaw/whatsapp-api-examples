'use strict';

/**
 * A dependency-free reader for the part of YAML that OpenAPI documents are
 * written in, so the Postman collection builds offline with nothing to
 * install.
 *
 * Supported: block mappings and sequences (including "- key: value" items and
 * a sequence written at the same indentation as its key), flow collections
 * ([a, b] and { a: 1 }, also across lines), plain, single-quoted and
 * double-quoted scalars, multi-line plain scalars, literal (|) and folded (>)
 * block scalars with the strip (-) and keep (+) chomping indicators, and
 * comments. Scalars resolve as in the YAML 1.2 core schema: null, booleans,
 * integers and floats, and everything else is a string. Timestamps stay
 * strings, which is what an OpenAPI document means by them.
 *
 * Anything outside that subset (anchors, aliases, tags, directives, several
 * documents, complex or merge keys, tab indentation, explicit block
 * indentation, quoted scalars spanning lines, hex or underscored numbers)
 * throws a YamlSubsetError naming the line, instead of being read wrongly.
 *
 * `node postman/check-collection.js --cross-check` compares this reader with
 * js-yaml on postman/openapi.yaml.
 */

class YamlSubsetError extends Error {
  constructor(message, lineIndex) {
    super(lineIndex === undefined ? message : `line ${lineIndex + 1}: ${message}`);
    this.name = 'YamlSubsetError';
    this.line = lineIndex === undefined ? undefined : lineIndex + 1;
  }
}

const NULL_RE = /^(?:~|null|Null|NULL)$/;
const TRUE_RE = /^(?:true|True|TRUE)$/;
const FALSE_RE = /^(?:false|False|FALSE)$/;
const INT_RE = /^[-+]?[0-9]+$/;
const FLOAT_RE = /^(?:[-+]?[0-9]+(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|[-+]?\.[0-9]+(?:[eE][-+]?[0-9]+)?)$/;
const SPECIAL_FLOATS = {
  '.inf': Infinity, '.Inf': Infinity, '.INF': Infinity,
  '+.inf': Infinity, '+.Inf': Infinity, '+.INF': Infinity,
  '-.inf': -Infinity, '-.Inf': -Infinity, '-.INF': -Infinity,
  '.nan': NaN, '.NaN': NaN, '.NAN': NaN,
};

/** Resolves a plain scalar to null, a boolean, a number or a string. */
const resolvePlain = (text, lineIndex) => {
  if (text === '' || NULL_RE.test(text)) return null;
  if (TRUE_RE.test(text)) return true;
  if (FALSE_RE.test(text)) return false;
  if (INT_RE.test(text)) return Number.parseInt(text, 10);
  if (FLOAT_RE.test(text)) return Number.parseFloat(text);
  if (Object.prototype.hasOwnProperty.call(SPECIAL_FLOATS, text)) return SPECIAL_FLOATS[text];
  if (/^[-+]?0[box][0-9a-fA-F_]+$/.test(text) || /^[-+]?[0-9][0-9_]*(?:\.[0-9_]*)?$/.test(text)) {
    throw new YamlSubsetError(`number written in a form this reader does not support: ${text}`, lineIndex);
  }
  return text;
};

const DOUBLE_QUOTE_ESCAPES = {
  0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: ' ', L: ' ', P: ' ',
};
const HEX_ESCAPE_LENGTH = { x: 2, u: 4, U: 8 };

/**
 * Reads a quoted scalar starting at text[start] (a ' or a ").
 * @returns {{ value: string, end: number }} end is the index after the closing quote
 */
const readQuoted = (text, start, lineIndex) => {
  const quote = text[start];
  let value = '';
  let p = start + 1;
  while (p < text.length) {
    const c = text[p];
    if (c === '\n') {
      throw new YamlSubsetError('quoted scalars that span lines are not supported', lineIndex);
    }
    if (quote === "'") {
      if (c === "'") {
        if (text[p + 1] === "'") {
          value += "'";
          p += 2;
          continue;
        }
        return { value, end: p + 1 };
      }
      value += c;
      p += 1;
      continue;
    }
    if (c === '"') return { value, end: p + 1 };
    if (c === '\\') {
      const e = text[p + 1];
      if (Object.prototype.hasOwnProperty.call(HEX_ESCAPE_LENGTH, e)) {
        const length = HEX_ESCAPE_LENGTH[e];
        const hex = text.slice(p + 2, p + 2 + length);
        if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) {
          throw new YamlSubsetError(`bad escape \\${e}${hex}`, lineIndex);
        }
        value += String.fromCodePoint(Number.parseInt(hex, 16));
        p += 2 + length;
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(DOUBLE_QUOTE_ESCAPES, e)) {
        throw new YamlSubsetError(`unknown escape \\${e === undefined ? '' : e}`, lineIndex);
      }
      value += DOUBLE_QUOTE_ESCAPES[e];
      p += 2;
      continue;
    }
    value += c;
    p += 1;
  }
  throw new YamlSubsetError('quoted scalars that span lines are not supported', lineIndex);
};

/** True when what remains of a line is nothing or a comment. */
const isBlankOrComment = (rest) => /^[ \t]*(?:#.*)?$/.test(rest);

/** Defines a key without ever touching the prototype (a key named __proto__ stays data). */
const setKey = (object, key, value, lineIndex) => {
  if (Object.prototype.hasOwnProperty.call(object, key)) {
    throw new YamlSubsetError(`duplicated mapping key: ${key}`, lineIndex);
  }
  Object.defineProperty(object, key, {
    value, enumerable: true, writable: true, configurable: true,
  });
};

/** Keys are strings in JSON: a plain key is resolved first, then turned into text. */
const keyToString = (key, lineIndex) => {
  if (key === '<<') throw new YamlSubsetError('merge keys (<<) are not supported', lineIndex);
  return String(key);
};

/**
 * Parses a flow collection held in `text` (which may contain newlines).
 */
const parseFlow = (text, lineIndex) => {
  let p = 0;

  const skipSpace = () => {
    while (p < text.length) {
      const c = text[p];
      if (c === ' ' || c === '\t' || c === '\n') {
        p += 1;
      } else if (c === '#' && (p === 0 || /[ \t\n]/.test(text[p - 1]))) {
        while (p < text.length && text[p] !== '\n') p += 1;
      } else {
        break;
      }
    }
  };

  const readPlain = (isKey) => {
    const start = p;
    while (p < text.length) {
      const c = text[p];
      if (c === ',' || c === '[' || c === ']' || c === '{' || c === '}' || c === '\n') break;
      if (c === '#' && /[ \t]/.test(text[p - 1])) break;
      if (c === ':' && (p + 1 >= text.length || /[ \t\n,\]}]/.test(text[p + 1]))) {
        if (isKey) break;
        throw new YamlSubsetError('a plain value inside a flow collection cannot contain ": "', lineIndex);
      }
      p += 1;
    }
    const raw = text.slice(start, p).trim();
    if (raw === '' && !isKey) throw new YamlSubsetError('empty value in a flow collection', lineIndex);
    if (/^[&*!%@`|>]/.test(raw)) {
      throw new YamlSubsetError(`anchors, aliases, tags and reserved indicators are not supported: ${raw}`, lineIndex);
    }
    return resolvePlain(raw, lineIndex);
  };

  const readNode = (isKey = false) => {
    skipSpace();
    const c = text[p];
    if (c === '[') {
      p += 1;
      const list = [];
      for (;;) {
        skipSpace();
        if (text[p] === ']') { p += 1; return list; }
        list.push(readNode());
        skipSpace();
        if (text[p] === ',') { p += 1; continue; }
        if (text[p] === ']') { p += 1; return list; }
        throw new YamlSubsetError('expected "," or "]" in a flow sequence', lineIndex);
      }
    }
    if (c === '{') {
      p += 1;
      const map = {};
      for (;;) {
        skipSpace();
        if (text[p] === '}') { p += 1; return map; }
        const key = keyToString(readNode(true), lineIndex);
        skipSpace();
        let value = null;
        if (text[p] === ':') {
          p += 1;
          skipSpace();
          if (text[p] !== ',' && text[p] !== '}') value = readNode();
        }
        setKey(map, key, value, lineIndex);
        skipSpace();
        if (text[p] === ',') { p += 1; continue; }
        if (text[p] === '}') { p += 1; return map; }
        throw new YamlSubsetError('expected "," or "}" in a flow mapping', lineIndex);
      }
    }
    if (c === '"' || c === "'") {
      const { value, end } = readQuoted(text, p, lineIndex);
      p = end;
      return value;
    }
    if (c === undefined) throw new YamlSubsetError('unterminated flow collection', lineIndex);
    return readPlain(isKey);
  };

  const value = readNode();
  skipSpace();
  if (p < text.length) {
    throw new YamlSubsetError(`unexpected text after a flow collection: ${text.slice(p).trim()}`, lineIndex);
  }
  return value;
};

/**
 * Parses a YAML document in the supported subset.
 * @param {string} source
 * @returns {*} the document as plain JavaScript values
 */
const parseYaml = (source) => {
  let text = String(source).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!text.endsWith('\n')) text += '\n';
  const lines = text.split('\n');
  lines.pop();
  let i = 0;

  const isBlank = (line) => /^[ \t]*$/.test(line);
  const isComment = (line) => /^[ \t]*#/.test(line);

  const indentOf = (index) => {
    const line = lines[index];
    let n = 0;
    while (line[n] === ' ') n += 1;
    if (line[n] === '\t') throw new YamlSubsetError('tabs cannot be used for indentation', index);
    return n;
  };

  const skipIgnorable = () => {
    while (i < lines.length && (isBlank(lines[i]) || isComment(lines[i]))) i += 1;
  };

  const isSequenceEntry = (content) => content === '-' || content.startsWith('- ');

  /**
   * Index of the ":" that ends a block mapping key in `content`, or -1 when
   * the content is not a "key: value" entry.
   */
  const findKeyColon = (content, lineIndex) => {
    if (content.startsWith('? ') || content === '?') {
      throw new YamlSubsetError('complex mapping keys (?) are not supported', lineIndex);
    }
    let p = 0;
    if (content[0] === '"' || content[0] === "'") {
      p = readQuoted(content, 0, lineIndex).end;
      while (content[p] === ' ') p += 1;
      return content[p] === ':' && (p + 1 === content.length || content[p + 1] === ' ') ? p : -1;
    }
    if (/^[[{&*!%@`|>]/.test(content)) return -1;
    for (; p < content.length; p += 1) {
      const c = content[p];
      if (c === '#' && p > 0 && content[p - 1] === ' ') return -1;
      if (c === ':' && (p + 1 === content.length || content[p + 1] === ' ')) return p;
    }
    return -1;
  };

  const readKey = (content, colon, lineIndex) => {
    const raw = content.slice(0, colon).trim();
    if (raw[0] === '"' || raw[0] === "'") return readQuoted(raw, 0, lineIndex).value;
    if (raw === '<<') throw new YamlSubsetError('merge keys (<<) are not supported', lineIndex);
    return keyToString(resolvePlain(raw, lineIndex), lineIndex);
  };

  /**
   * Reads a block scalar whose header (|, >, |-, >+ ...) is `header`. The
   * line breaks follow the YAML 1.2 rules for literal and folded scalars.
   */
  const readBlockScalar = (header, parentIndent, headerLine) => {
    const folding = header[0] === '>';
    let chomping = 'clip';
    let p = 1;
    for (; p < header.length; p += 1) {
      const c = header[p];
      if ((c === '-' || c === '+') && chomping === 'clip') {
        chomping = c === '-' ? 'strip' : 'keep';
      } else if (/[0-9]/.test(c)) {
        throw new YamlSubsetError('explicit block indentation indicators are not supported', headerLine);
      } else {
        break;
      }
    }
    if (!isBlankOrComment(header.slice(p)) || (header[p] !== undefined && header[p] !== ' ' && header[p] !== '\t')) {
      throw new YamlSubsetError(`unexpected text after a block scalar indicator: ${header}`, headerLine);
    }

    let result = '';
    let textIndent = parentIndent + 1;
    let detectedIndent = false;
    let didReadContent = false;
    let emptyLines = 0;
    let atMoreIndented = false;

    const chomp = () => {
      if (chomping === 'keep') {
        result += '\n'.repeat(didReadContent ? 1 + emptyLines : emptyLines);
      } else if (chomping === 'clip' && didReadContent) {
        result += '\n';
      }
    };

    for (;;) {
      if (i >= lines.length) {
        chomp();
        return result;
      }
      const line = lines[i];
      let lineIndent = 0;
      while ((!detectedIndent || lineIndent < textIndent) && line[lineIndent] === ' ') lineIndent += 1;
      if (!detectedIndent && lineIndent > textIndent) textIndent = lineIndent;
      const first = line[lineIndent];

      if (first === undefined) {
        emptyLines += 1;
        i += 1;
        continue;
      }
      if (lineIndent < textIndent) {
        chomp();
        return result;
      }

      if (folding) {
        if (first === ' ' || first === '\t') {
          atMoreIndented = true;
          result += '\n'.repeat(didReadContent ? 1 + emptyLines : emptyLines);
        } else if (atMoreIndented) {
          atMoreIndented = false;
          result += '\n'.repeat(emptyLines + 1);
        } else if (emptyLines === 0) {
          if (didReadContent) result += ' ';
        } else {
          result += '\n'.repeat(emptyLines);
        }
      } else {
        result += '\n'.repeat(didReadContent ? 1 + emptyLines : emptyLines);
      }

      result += line.slice(lineIndent);
      didReadContent = true;
      detectedIndent = true;
      emptyLines = 0;
      i += 1;
    }
  };

  /** Reads a flow collection that starts in `first` and may continue on the next lines. */
  const readFlowCollection = (first, headerLine) => {
    let buffer = first;
    let depth = 0;
    let quote = null;
    const scan = (chunk) => {
      for (let p = 0; p < chunk.length; p += 1) {
        const c = chunk[p];
        if (quote) {
          if (quote === '"' && c === '\\') { p += 1; continue; }
          if (c === quote) quote = null;
          continue;
        }
        if (c === '#' && (p === 0 || /[ \t]/.test(chunk[p - 1]))) return;
        if ((c === '"' || c === "'") && (p === 0 || /[\s[{,:]/.test(chunk[p - 1]))) quote = c;
        else if (c === '[' || c === '{') depth += 1;
        else if (c === ']' || c === '}') depth -= 1;
      }
    };
    scan(first);
    while (depth > 0) {
      if (i >= lines.length) throw new YamlSubsetError('unterminated flow collection', headerLine);
      const next = lines[i];
      i += 1;
      scan(next);
      buffer += '\n' + next;
    }
    return parseFlow(buffer, headerLine);
  };

  /**
   * Reads the value that follows "key:" or "- " on a line. `rest` is the text
   * after the indicator, `parentIndent` the indentation of the mapping or
   * sequence it belongs to. The caller has already moved past the line.
   */
  const readValue = (rest, parentIndent, lineIndex, allowCompactSequence) => {
    const text = rest.replace(/^[ \t]+/, '');

    if (isBlankOrComment(text)) {
      skipIgnorable();
      if (i >= lines.length) return null;
      const indent = indentOf(i);
      if (indent > parentIndent) return readNode(indent);
      if (allowCompactSequence && indent === parentIndent && isSequenceEntry(lines[i].slice(indent))) {
        return readSequence(indent);
      }
      return null;
    }

    const c = text[0];
    if (c === '|' || c === '>') return readBlockScalar(text, parentIndent, lineIndex);
    if (c === '[' || c === '{') return readFlowCollection(text, lineIndex);
    if (c === '"' || c === "'") {
      const { value, end } = readQuoted(text, 0, lineIndex);
      if (!isBlankOrComment(text.slice(end))) {
        throw new YamlSubsetError(`unexpected text after a quoted scalar: ${text.slice(end).trim()}`, lineIndex);
      }
      return value;
    }
    if (/^[&*!%@`]/.test(text)) {
      throw new YamlSubsetError(`anchors, aliases, tags and reserved indicators are not supported: ${text}`, lineIndex);
    }
    if (isSequenceEntry(text)) {
      throw new YamlSubsetError('a sequence cannot start on the same line as its key', lineIndex);
    }

    // A plain scalar, possibly continued on more indented lines.
    let value = text.replace(/[ \t]+#.*$/, '').replace(/[ \t]+$/, '');
    if (/: |:$/.test(value)) {
      throw new YamlSubsetError(`a plain value cannot contain ": " (quote it): ${value}`, lineIndex);
    }
    let pendingBlank = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) {
        pendingBlank += 1;
        i += 1;
        continue;
      }
      if (isComment(line) || indentOf(i) <= parentIndent) break;
      const continuation = line.trim().replace(/[ \t]+#.*$/, '');
      if (findKeyColon(continuation, i) !== -1 || /: |:$/.test(continuation)) {
        throw new YamlSubsetError('a mapping entry is indented under a plain value', i);
      }
      value += pendingBlank ? '\n'.repeat(pendingBlank) : ' ';
      value += continuation;
      pendingBlank = 0;
      i += 1;
    }
    return resolvePlain(value, lineIndex);
  };

  const readMapping = (indent) => {
    const map = {};
    for (;;) {
      skipIgnorable();
      if (i >= lines.length) return map;
      const lineIndex = i;
      const lineIndent = indentOf(i);
      if (lineIndent < indent) return map;
      if (lineIndent > indent) throw new YamlSubsetError('bad indentation of a mapping entry', lineIndex);
      const content = lines[i].slice(indent);
      if (isSequenceEntry(content)) {
        throw new YamlSubsetError('a sequence entry where a mapping key was expected', lineIndex);
      }
      if (/^(?:---|\.\.\.)(?:\s|$)/.test(content)) {
        throw new YamlSubsetError('several documents in one file are not supported', lineIndex);
      }
      const colon = findKeyColon(content, lineIndex);
      if (colon === -1) throw new YamlSubsetError(`expected "key: value": ${content.trim()}`, lineIndex);
      const key = readKey(content, colon, lineIndex);
      i += 1;
      setKey(map, key, readValue(content.slice(colon + 1), indent, lineIndex, true), lineIndex);
    }
  };

  const readSequence = (indent) => {
    const list = [];
    for (;;) {
      skipIgnorable();
      if (i >= lines.length) return list;
      const lineIndex = i;
      const lineIndent = indentOf(i);
      if (lineIndent < indent) return list;
      if (lineIndent > indent) throw new YamlSubsetError('bad indentation of a sequence entry', lineIndex);
      const content = lines[i].slice(indent);
      if (!isSequenceEntry(content)) return list;

      let offset = 1;
      while (content[offset] === ' ') offset += 1;
      const rest = content.slice(offset);
      if (rest !== '' && !isBlankOrComment(rest)
          && (isSequenceEntry(rest) || findKeyColon(rest, lineIndex) !== -1)) {
        // "- key: value" or "- - item": a block node that starts on this line.
        lines[i] = ' '.repeat(indent + offset) + rest;
        list.push(readNode(indent + offset));
        continue;
      }
      i += 1;
      list.push(readValue(rest, indent, lineIndex, false));
    }
  };

  /** Reads the block node whose first line is lines[i], indented by `indent`. */
  const readNode = (indent) => {
    const lineIndex = i;
    const content = lines[i].slice(indent);
    if (isSequenceEntry(content)) return readSequence(indent);
    if (findKeyColon(content, lineIndex) !== -1) return readMapping(indent);
    i += 1;
    return readValue(content, indent - 1, lineIndex, false);
  };

  skipIgnorable();
  if (i < lines.length && /^%/.test(lines[i])) {
    throw new YamlSubsetError('YAML directives are not supported', i);
  }
  if (i < lines.length && /^---(?:\s|$)/.test(lines[i])) {
    if (!isBlankOrComment(lines[i].slice(3))) {
      throw new YamlSubsetError('content on the document start line is not supported', i);
    }
    i += 1;
    skipIgnorable();
  }
  if (i >= lines.length) return null;
  const document = readNode(indentOf(i));
  skipIgnorable();
  if (i < lines.length) {
    throw new YamlSubsetError(`unexpected content: ${lines[i].trim()}`, i);
  }
  return document;
};

module.exports = { parseYaml, YamlSubsetError };
