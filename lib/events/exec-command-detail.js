'use strict';

const MAX_EXEC_SOURCE_CHARS = 65536;
const MAX_EXEC_COMMANDS = 32;
const MAX_EXEC_IMAGES = 20;
const SHELL_COMMAND_KEYS = new Set([
  'command',
  'justification',
  'login',
  'prefix_rule',
  'sandbox_permissions',
  'timeout_ms',
  'workdir',
]);
const INVALID_RESULT_BINDINGS = new Set([
  'arguments', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'eval', 'export', 'extends', 'false', 'finally', 'for', 'function',
  'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package',
  'private', 'Promise', 'protected', 'public', 'return', 'static', 'super', 'switch', 'text', 'this', 'throw',
  'tools', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

function skipWhitespace(source, index) {
  let cursor = index;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  return cursor;
}

function identifierStart(value) {
  return /[A-Za-z_$]/.test(value || '');
}

function identifierPart(value) {
  return /[A-Za-z0-9_$]/.test(value || '');
}

function readIdentifier(source, start) {
  if (!identifierStart(source[start])) return undefined;
  let end = start + 1;
  while (end < source.length && identifierPart(source[end])) end += 1;
  return { value: source.slice(start, end), end };
}

function readWord(source, start, word) {
  if (!source.startsWith(word, start) || identifierPart(source[start - 1]) || identifierPart(source[start + word.length])) {
    return undefined;
  }
  return start + word.length;
}

function hexValue(source, start, length) {
  const value = source.slice(start, start + length);
  return value.length === length && /^[0-9A-Fa-f]+$/.test(value) ? Number.parseInt(value, 16) : undefined;
}

function readStringLiteral(source, start) {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") return undefined;
  let value = '';
  let cursor = start + 1;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === quote) return { kind: 'string', value, end: cursor + 1 };
    if (character === '\n' || character === '\r') return undefined;
    if (character !== '\\') {
      value += character;
      cursor += 1;
      continue;
    }
    cursor += 1;
    if (cursor >= source.length) return undefined;
    const escaped = source[cursor];
    const simple = { '\\': '\\', '"': '"', "'": "'", n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };
    if (Object.prototype.hasOwnProperty.call(simple, escaped)) {
      value += simple[escaped];
      cursor += 1;
      continue;
    }
    if (escaped === '0' && !/[0-9]/.test(source[cursor + 1] || '')) {
      value += '\0';
      cursor += 1;
      continue;
    }
    if (escaped === 'x') {
      const code = hexValue(source, cursor + 1, 2);
      if (code === undefined) return undefined;
      value += String.fromCharCode(code);
      cursor += 3;
      continue;
    }
    if (escaped === 'u') {
      if (source[cursor + 1] === '{') {
        const close = source.indexOf('}', cursor + 2);
        if (close < 0 || close - (cursor + 2) < 1 || close - (cursor + 2) > 6) return undefined;
        const codeText = source.slice(cursor + 2, close);
        if (!/^[0-9A-Fa-f]+$/.test(codeText)) return undefined;
        const code = Number.parseInt(codeText, 16);
        if (code > 0x10FFFF) return undefined;
        value += String.fromCodePoint(code);
        cursor = close + 1;
        continue;
      }
      const code = hexValue(source, cursor + 1, 4);
      if (code === undefined) return undefined;
      value += String.fromCharCode(code);
      cursor += 5;
      continue;
    }
    if (escaped === '\n') {
      cursor += 1;
      continue;
    }
    if (escaped === '\r') {
      cursor += source[cursor + 1] === '\n' ? 2 : 1;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function readNumberLiteral(source, start) {
  const match = source.slice(start).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
  if (!match) return undefined;
  return { kind: 'number', value: Number(match[0]), end: start + match[0].length };
}

function readPrimitive(source, start) {
  const cursor = skipWhitespace(source, start);
  const string = readStringLiteral(source, cursor);
  if (string) return string;
  const number = readNumberLiteral(source, cursor);
  if (number) return number;
  for (const [word, value] of [['true', true], ['false', false], ['null', null]]) {
    const end = readWord(source, cursor, word);
    if (end !== undefined) return { kind: 'primitive', value, end };
  }
  return undefined;
}

function readLiteralValue(source, start) {
  let cursor = skipWhitespace(source, start);
  if (source[cursor] !== '[') return readPrimitive(source, cursor);
  cursor = skipWhitespace(source, cursor + 1);
  const values = [];
  if (source[cursor] === ']') return { kind: 'array', value: values, end: cursor + 1 };
  while (cursor < source.length) {
    const item = readPrimitive(source, cursor);
    if (!item) return undefined;
    values.push(item.value);
    cursor = skipWhitespace(source, item.end);
    if (source[cursor] === ']') return { kind: 'array', value: values, end: cursor + 1 };
    if (source[cursor] !== ',') return undefined;
    cursor = skipWhitespace(source, cursor + 1);
    if (source[cursor] === ']') return { kind: 'array', value: values, end: cursor + 1 };
  }
  return undefined;
}

function validShellCommandValue(key, value) {
  if (key === 'command' || key === 'justification' || key === 'workdir') {
    return value.kind === 'string';
  }
  if (key === 'sandbox_permissions') {
    return value.kind === 'string' && ['use_default', 'require_escalated'].includes(value.value);
  }
  if (key === 'login') return value.kind === 'primitive' && typeof value.value === 'boolean';
  if (key === 'timeout_ms') return value.kind === 'number' && Number.isFinite(value.value) && value.value >= 0;
  if (key === 'prefix_rule') return value.kind === 'array' && value.value.every((item) => typeof item === 'string');
  return false;
}

function readShellCommandObject(source, start) {
  let cursor = skipWhitespace(source, start);
  if (source[cursor] !== '{') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  const keys = new Set();
  let command;
  if (source[cursor] === '}') return undefined;
  while (cursor < source.length) {
    let key;
    const quotedKey = readStringLiteral(source, cursor);
    if (quotedKey) {
      key = quotedKey.value;
      cursor = quotedKey.end;
    } else {
      const identifier = readIdentifier(source, cursor);
      if (!identifier) return undefined;
      key = identifier.value;
      cursor = identifier.end;
    }
    if (!SHELL_COMMAND_KEYS.has(key) || keys.has(key)) return undefined;
    keys.add(key);
    cursor = skipWhitespace(source, cursor);
    if (source[cursor] !== ':') return undefined;
    const value = readLiteralValue(source, cursor + 1);
    if (!value || !validShellCommandValue(key, value)) return undefined;
    if (key === 'command') command = value.value;
    cursor = skipWhitespace(source, value.end);
    if (source[cursor] === '}') return command === undefined ? undefined : { command, end: cursor + 1 };
    if (source[cursor] !== ',') return undefined;
    cursor = skipWhitespace(source, cursor + 1);
    if (source[cursor] === '}') return command === undefined ? undefined : { command, end: cursor + 1 };
  }
  return undefined;
}

function readExactShellCommandCall(source, start) {
  const marker = 'tools.shell_command';
  if (!source.startsWith(marker, start)) return undefined;
  let cursor = skipWhitespace(source, start + marker.length);
  if (source[cursor] !== '(') return undefined;
  const object = readShellCommandObject(source, cursor + 1);
  if (!object) return undefined;
  cursor = skipWhitespace(source, object.end);
  if (source[cursor] !== ')') return undefined;
  return { command: object.command, end: cursor + 1 };
}

function readStaticLabelValue(source, start, indexBinding = '') {
  const cursor = skipWhitespace(source, start);
  const string = readStringLiteral(source, cursor);
  if (string) return { end: string.end };
  if (source[cursor] !== '`') return undefined;
  let position = cursor + 1;
  while (position < source.length) {
    if (source[position] === '\\') {
      position += 2;
      continue;
    }
    if (source[position] === '`') return { end: position + 1 };
    if (source[position] !== '$' || source[position + 1] !== '{') {
      position += 1;
      continue;
    }
    if (!indexBinding) return undefined;
    const close = source.indexOf('}', position + 2);
    if (close < 0) return undefined;
    const expression = source.slice(position + 2, close);
    let expressionCursor = skipWhitespace(expression, 0);
    const identifier = readIdentifier(expression, expressionCursor);
    if (!identifier || identifier.value !== indexBinding) return undefined;
    expressionCursor = skipWhitespace(expression, identifier.end);
    if (expressionCursor < expression.length) {
      if (expression[expressionCursor] !== '+') return undefined;
      const number = readNumberLiteral(expression, skipWhitespace(expression, expressionCursor + 1));
      if (!number || !Number.isSafeInteger(number.value) || number.value < 0) return undefined;
      expressionCursor = skipWhitespace(expression, number.end);
    }
    if (expressionCursor !== expression.length) return undefined;
    position = close + 1;
  }
  return undefined;
}

function readStaticLabelConsumer(source, start, indexBinding = '') {
  let cursor = skipWhitespace(source, start);
  const textEnd = readWord(source, cursor, 'text');
  if (textEnd === undefined) return undefined;
  cursor = skipWhitespace(source, textEnd);
  if (source[cursor] !== '(') return undefined;
  const value = readStaticLabelValue(source, cursor + 1, indexBinding);
  if (!value) return undefined;
  cursor = skipWhitespace(source, value.end);
  if (source[cursor] !== ')') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  if (source[cursor] !== ';') return undefined;
  return skipWhitespace(source, cursor + 1);
}

function readResultConsumer(source, start, assignment) {
  let cursor = skipWhitespace(source, start);
  const textEnd = readWord(source, cursor, 'text');
  if (textEnd === undefined) return undefined;
  cursor = skipWhitespace(source, textEnd);
  if (source[cursor] !== '(') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  const result = readIdentifier(source, cursor);
  if (!result || result.value !== assignment) return undefined;
  cursor = skipWhitespace(source, result.end);
  if (source[cursor] !== ')') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  const terminated = source[cursor] === ';';
  if (terminated) cursor = skipWhitespace(source, cursor + 1);
  return { end: cursor, terminated };
}

function readShellCommandStatement(source, start, bindings) {
  let cursor = skipWhitespace(source, start);
  let assignment = '';
  let terminated = false;
  const constEnd = readWord(source, cursor, 'const');
  if (constEnd !== undefined) {
    cursor = skipWhitespace(source, constEnd);
    const identifier = readIdentifier(source, cursor);
    if (!identifier || INVALID_RESULT_BINDINGS.has(identifier.value) || bindings.has(identifier.value)) return undefined;
    assignment = identifier.value;
    cursor = skipWhitespace(source, identifier.end);
    if (source[cursor] !== '=') return undefined;
    cursor = skipWhitespace(source, cursor + 1);
  }
  const awaitEnd = readWord(source, cursor, 'await');
  if (awaitEnd === undefined) return undefined;
  cursor = skipWhitespace(source, awaitEnd);
  const call = readExactShellCommandCall(source, cursor);
  if (!call) return undefined;
  cursor = skipWhitespace(source, call.end);
  if (assignment) {
    if (source[cursor] !== ';') return undefined;
    const consumer = readResultConsumer(source, cursor + 1, assignment);
    if (!consumer) return undefined;
    cursor = consumer.end;
    terminated = consumer.terminated;
    bindings.add(assignment);
  } else if (source[cursor] === ';') {
    cursor = skipWhitespace(source, cursor + 1);
    terminated = true;
  }
  return { command: call.command, end: cursor, terminated };
}

function readPromiseForEach(source, start, assignment) {
  let cursor = skipWhitespace(source, start);
  const result = readIdentifier(source, cursor);
  if (!result || result.value !== assignment) return undefined;
  cursor = result.end;
  if (!source.startsWith('.forEach', cursor)) return undefined;
  cursor = skipWhitespace(source, cursor + '.forEach'.length);
  if (source[cursor] !== '(') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  const textEnd = readWord(source, cursor, 'text');
  if (textEnd === undefined) return undefined;
  cursor = skipWhitespace(source, textEnd);
  if (source[cursor] !== ')') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  if (source[cursor] === ';') cursor = skipWhitespace(source, cursor + 1);
  return cursor;
}

function readPromiseForOf(source, start, assignment) {
  let cursor = skipWhitespace(source, start);
  const forEnd = readWord(source, cursor, 'for');
  if (forEnd === undefined) return undefined;
  cursor = skipWhitespace(source, forEnd);
  if (source[cursor] !== '(') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  const constEnd = readWord(source, cursor, 'const');
  if (constEnd === undefined) return undefined;
  cursor = skipWhitespace(source, constEnd);
  const item = readIdentifier(source, cursor);
  if (!item || INVALID_RESULT_BINDINGS.has(item.value) || item.value === assignment) return undefined;
  cursor = skipWhitespace(source, item.end);
  const ofEnd = readWord(source, cursor, 'of');
  if (ofEnd === undefined) return undefined;
  cursor = skipWhitespace(source, ofEnd);
  const result = readIdentifier(source, cursor);
  if (!result || result.value !== assignment) return undefined;
  cursor = skipWhitespace(source, result.end);
  if (source[cursor] !== ')') return undefined;
  return readResultConsumer(source, cursor + 1, item.value)?.end;
}

function readMappedResultConsumer(source, start, assignment) {
  let cursor = skipWhitespace(source, start);
  const result = readIdentifier(source, cursor);
  if (!result || result.value !== assignment) return undefined;
  cursor = result.end;
  if (!source.startsWith('.forEach', cursor)) return undefined;
  cursor = skipWhitespace(source, cursor + '.forEach'.length);
  if (source[cursor] !== '(') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  if (source[cursor] !== '(') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  const item = readIdentifier(source, cursor);
  if (!item || INVALID_RESULT_BINDINGS.has(item.value) || item.value === assignment) return undefined;
  cursor = skipWhitespace(source, item.end);
  if (source[cursor] !== ',') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  const index = readIdentifier(source, cursor);
  if (!index || INVALID_RESULT_BINDINGS.has(index.value)
    || index.value === assignment || index.value === item.value) return undefined;
  cursor = skipWhitespace(source, index.end);
  if (source[cursor] !== ')') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  if (!source.startsWith('=>', cursor)) return undefined;
  cursor = skipWhitespace(source, cursor + 2);
  if (source[cursor] !== '{') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  const labelEnd = readStaticLabelConsumer(source, cursor, index.value);
  if (labelEnd !== undefined) cursor = labelEnd;
  const consumer = readResultConsumer(source, cursor, item.value);
  if (!consumer) return undefined;
  cursor = skipWhitespace(source, consumer.end);
  if (source[cursor] !== '}') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  if (source[cursor] !== ')') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  if (source[cursor] === ';') cursor = skipWhitespace(source, cursor + 1);
  return cursor;
}

function readStaticMappedCommands(source) {
  let cursor = skipWhitespace(source, 0);
  const constEnd = readWord(source, cursor, 'const');
  if (constEnd === undefined) return undefined;
  cursor = skipWhitespace(source, constEnd);
  const commandArray = readIdentifier(source, cursor);
  if (!commandArray || INVALID_RESULT_BINDINGS.has(commandArray.value)) return undefined;
  cursor = skipWhitespace(source, commandArray.end);
  if (source[cursor] !== '=') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  if (source[cursor] !== '[') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  const commands = [];
  while (cursor < source.length && source[cursor] !== ']') {
    const object = readShellCommandObject(source, cursor);
    if (!object || commands.length >= MAX_EXEC_COMMANDS) return undefined;
    commands.push(object.command);
    cursor = skipWhitespace(source, object.end);
    if (source[cursor] === ']') break;
    if (source[cursor] !== ',') return undefined;
    cursor = skipWhitespace(source, cursor + 1);
    if (source[cursor] === ']') break;
  }
  if (commands.length === 0 || source[cursor] !== ']') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  if (source[cursor] !== ';') return undefined;
  cursor = skipWhitespace(source, cursor + 1);

  const resultConstEnd = readWord(source, cursor, 'const');
  if (resultConstEnd === undefined) return undefined;
  cursor = skipWhitespace(source, resultConstEnd);
  const result = readIdentifier(source, cursor);
  if (!result || INVALID_RESULT_BINDINGS.has(result.value) || result.value === commandArray.value) return undefined;
  cursor = skipWhitespace(source, result.end);
  if (source[cursor] !== '=') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  const awaitEnd = readWord(source, cursor, 'await');
  if (awaitEnd === undefined) return undefined;
  cursor = skipWhitespace(source, awaitEnd);
  if (!source.startsWith('Promise.all', cursor)) return undefined;
  cursor = skipWhitespace(source, cursor + 'Promise.all'.length);
  if (source[cursor] !== '(') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  const mappedArray = readIdentifier(source, cursor);
  if (!mappedArray || mappedArray.value !== commandArray.value) return undefined;
  cursor = mappedArray.end;
  if (!source.startsWith('.map', cursor)) return undefined;
  cursor = skipWhitespace(source, cursor + '.map'.length);
  if (source[cursor] !== '(') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  const parameter = readIdentifier(source, cursor);
  if (!parameter || INVALID_RESULT_BINDINGS.has(parameter.value)
    || parameter.value === commandArray.value || parameter.value === result.value) return undefined;
  cursor = skipWhitespace(source, parameter.end);
  if (!source.startsWith('=>', cursor)) return undefined;
  cursor = skipWhitespace(source, cursor + 2);
  if (!source.startsWith('tools.shell_command', cursor)) return undefined;
  cursor = skipWhitespace(source, cursor + 'tools.shell_command'.length);
  if (source[cursor] !== '(') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  const argument = readIdentifier(source, cursor);
  if (!argument || argument.value !== parameter.value) return undefined;
  cursor = skipWhitespace(source, argument.end);
  if (source[cursor] !== ')') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  if (source[cursor] !== ')') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  if (source[cursor] !== ')') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  if (source[cursor] !== ';') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  const directConsumer = readPromiseForEach(source, cursor, result.value);
  const mappedConsumer = directConsumer === undefined
    ? readMappedResultConsumer(source, cursor, result.value)
    : undefined;
  const end = directConsumer === undefined ? mappedConsumer : directConsumer;
  return end === source.length ? commands : undefined;
}

function readPromiseAllCommands(source) {
  let cursor = skipWhitespace(source, 0);
  const constEnd = readWord(source, cursor, 'const');
  if (constEnd === undefined) return undefined;
  cursor = skipWhitespace(source, constEnd);
  const assignment = readIdentifier(source, cursor);
  if (!assignment || INVALID_RESULT_BINDINGS.has(assignment.value)) return undefined;
  cursor = skipWhitespace(source, assignment.end);
  if (source[cursor] !== '=') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  const awaitEnd = readWord(source, cursor, 'await');
  if (awaitEnd === undefined) return undefined;
  cursor = skipWhitespace(source, awaitEnd);
  if (!source.startsWith('Promise.all', cursor)) return undefined;
  cursor = skipWhitespace(source, cursor + 'Promise.all'.length);
  if (source[cursor] !== '(') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  if (source[cursor] !== '[') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  const commands = [];
  while (cursor < source.length && source[cursor] !== ']') {
    const call = readExactShellCommandCall(source, cursor);
    if (!call || commands.length >= MAX_EXEC_COMMANDS) return undefined;
    commands.push(call.command);
    cursor = skipWhitespace(source, call.end);
    if (source[cursor] === ']') break;
    if (source[cursor] !== ',') return undefined;
    cursor = skipWhitespace(source, cursor + 1);
    if (source[cursor] === ']') break;
  }
  if (commands.length < 2 || source[cursor] !== ']') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  if (source[cursor] !== ')') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  if (source[cursor] !== ';') return undefined;
  cursor = skipWhitespace(source, cursor + 1);
  const forEachEnd = readPromiseForEach(source, cursor, assignment.value);
  const forOfEnd = forEachEnd === undefined ? readPromiseForOf(source, cursor, assignment.value) : undefined;
  const end = forEachEnd === undefined ? forOfEnd : forEachEnd;
  return end === source.length ? commands : undefined;
}

function readSequentialCommands(source) {
  const commands = [];
  const bindings = new Set();
  let cursor = skipWhitespace(source, 0);
  while (cursor < source.length) {
    const statement = readShellCommandStatement(source, cursor, bindings);
    if (!statement || statement.end <= cursor || commands.length >= MAX_EXEC_COMMANDS) return undefined;
    commands.push(statement.command);
    cursor = statement.end;
    if (cursor < source.length && !statement.terminated) return undefined;
  }
  return commands.length > 0 ? commands : undefined;
}

function readDeferredSequentialCommands(source) {
  const declarations = [];
  const bindings = new Set();
  let cursor = skipWhitespace(source, 0);
  while (cursor < source.length && declarations.length < MAX_EXEC_COMMANDS) {
    const start = cursor;
    const constEnd = readWord(source, cursor, 'const');
    if (constEnd === undefined) break;
    cursor = skipWhitespace(source, constEnd);
    const binding = readIdentifier(source, cursor);
    if (!binding || INVALID_RESULT_BINDINGS.has(binding.value) || bindings.has(binding.value)) return undefined;
    cursor = skipWhitespace(source, binding.end);
    if (source[cursor] !== '=') return undefined;
    cursor = skipWhitespace(source, cursor + 1);
    const awaitEnd = readWord(source, cursor, 'await');
    if (awaitEnd === undefined) return undefined;
    cursor = skipWhitespace(source, awaitEnd);
    const call = readExactShellCommandCall(source, cursor);
    if (!call) return undefined;
    cursor = skipWhitespace(source, call.end);
    if (source[cursor] !== ';') return undefined;
    cursor = skipWhitespace(source, cursor + 1);
    bindings.add(binding.value);
    declarations.push({ binding: binding.value, command: call.command });
    if (cursor <= start) return undefined;
  }
  if (declarations.length < 2) return undefined;
  for (const declaration of declarations) {
    const labelEnd = readStaticLabelConsumer(source, cursor);
    if (labelEnd !== undefined) cursor = labelEnd;
    const consumer = readResultConsumer(source, cursor, declaration.binding);
    if (!consumer) return undefined;
    cursor = consumer.end;
    if (cursor < source.length && !consumer.terminated) return undefined;
  }
  return cursor === source.length ? declarations.map(item => item.command) : undefined;
}

function stripExactExecPragma(source) {
  if (!source.startsWith('// @exec:')) return source;
  const lineEnd = source.indexOf('\n');
  if (lineEnd < 0 || lineEnd > 4096) return undefined;
  const line = source.slice(0, lineEnd);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(line)) return undefined;
  if (line.includes('\r') && !line.endsWith('\r')) return undefined;
  return source.slice(lineEnd + 1);
}

function extractExactApplyPatch(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_EXEC_SOURCE_CHARS) return null;
  let cursor = skipWhitespace(input, 0);
  const constEnd = readWord(input, cursor, 'const');
  if (constEnd === undefined) return null;
  cursor = skipWhitespace(input, constEnd);
  const binding = readIdentifier(input, cursor);
  if (!binding || binding.value !== 'patch') return null;
  cursor = skipWhitespace(input, binding.end);
  if (input[cursor] !== '=') return null;
  const patch = readStringLiteral(input, skipWhitespace(input, cursor + 1));
  if (!patch || !patch.value) return null;
  cursor = skipWhitespace(input, patch.end);
  if (input[cursor] !== ';') return null;
  cursor = skipWhitespace(input, cursor + 1);
  const textEnd = readWord(input, cursor, 'text');
  if (textEnd === undefined) return null;
  cursor = skipWhitespace(input, textEnd);
  if (input[cursor] !== '(') return null;
  cursor = skipWhitespace(input, cursor + 1);
  const awaitEnd = readWord(input, cursor, 'await');
  if (awaitEnd === undefined) return null;
  cursor = skipWhitespace(input, awaitEnd);
  if (!input.startsWith('tools.apply_patch', cursor)) return null;
  cursor = skipWhitespace(input, cursor + 'tools.apply_patch'.length);
  if (input[cursor] !== '(') return null;
  cursor = skipWhitespace(input, cursor + 1);
  const argument = readIdentifier(input, cursor);
  if (!argument || argument.value !== binding.value) return null;
  cursor = skipWhitespace(input, argument.end);
  if (input[cursor] !== ')') return null;
  cursor = skipWhitespace(input, cursor + 1);
  if (input[cursor] !== ')') return null;
  cursor = skipWhitespace(input, cursor + 1);
  if (input[cursor] === ';') cursor = skipWhitespace(input, cursor + 1);
  return cursor === input.length ? patch.value : null;
}

function isExactApplyPatchWrapper(input) {
  return extractExactApplyPatch(input) !== null;
}

function extractShellCommands(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_EXEC_SOURCE_CHARS) return [];
  const source = stripExactExecPragma(input);
  if (source === undefined) return [];
  return readStaticMappedCommands(source)
    || readPromiseAllCommands(source)
    || readDeferredSequentialCommands(source)
    || readSequentialCommands(source)
    || [];
}

function extractSingleShellCommand(input) {
  const commands = extractShellCommands(input);
  return commands.length === 1 ? commands[0] : '';
}

const STATIC_STRING_TOKEN = String.raw`(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')`;
const STATIC_TEMPLATE_TOKEN = String.raw`(?:\x60(?:\\.|[^\x60\\])*\x60)`;
const STATIC_IDENTIFIER_TOKEN = String.raw`([A-Za-z_$][A-Za-z0-9_$]*)`;

function decodedStringToken(token) {
  const parsed = readStringLiteral(String(token || ''), 0);
  return parsed && parsed.end === token.length ? parsed.value : undefined;
}

function readStaticStringArray(source) {
  const values = [];
  let cursor = skipWhitespace(source, 0);
  while (cursor < source.length) {
    const value = readStringLiteral(source, cursor);
    if (!value || values.length >= MAX_EXEC_IMAGES) return undefined;
    values.push(value.value);
    cursor = skipWhitespace(source, value.end);
    if (cursor === source.length) return values;
    if (source[cursor] !== ',') return undefined;
    cursor = skipWhitespace(source, cursor + 1);
    if (cursor === source.length) return values;
  }
  return values.length ? values : undefined;
}

function expandStaticTemplate(token, binding, values) {
  if (typeof token !== 'string' || token[0] !== '`' || token[token.length - 1] !== '`') return undefined;
  const parts = [''];
  let cursor = 1;
  while (cursor < token.length - 1) {
    const character = token[cursor];
    if (character === '\\') {
      cursor += 1;
      if (cursor >= token.length - 1) return undefined;
      const escaped = token[cursor];
      const simple = { '\\': '\\', '`': '`', '$': '$', n: '\n', r: '\r', t: '\t' };
      if (!Object.prototype.hasOwnProperty.call(simple, escaped)) return undefined;
      parts[parts.length - 1] += simple[escaped];
      cursor += 1;
      continue;
    }
    if (character === '$' && token[cursor + 1] === '{') {
      const close = token.indexOf('}', cursor + 2);
      if (close < 0 || token.slice(cursor + 2, close).trim() !== binding) return undefined;
      parts.push(null, '');
      cursor = close + 1;
      continue;
    }
    parts[parts.length - 1] += character;
    cursor += 1;
  }
  if (!parts.includes(null)) return undefined;
  return values.map(value => parts.map(part => part === null ? value : part).join(''));
}

function exactSingleImageView(source) {
  const pattern = new RegExp(
    String.raw`^\s*const\s+${STATIC_IDENTIFIER_TOKEN}\s*=\s*await\s+tools\.view_image\s*\(\s*\{\s*(?:path|["']path["'])\s*:\s*(${STATIC_STRING_TOKEN})(?:\s*,\s*(?:detail|["']detail["'])\s*:\s*${STATIC_STRING_TOKEN})?\s*,?\s*\}\s*\)\s*;?\s*image\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\.image_url(?:\s*,\s*${STATIC_STRING_TOKEN})?\s*\)\s*;?(?:\s*text\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\.detail\s*\)\s*;?)?\s*$`,
  );
  const match = source.match(pattern);
  if (!match || match[1] !== match[3] || (match[4] && match[4] !== match[1])) return undefined;
  const filePath = decodedStringToken(match[2]);
  return filePath === undefined ? undefined : [filePath];
}

function exactArrayImageViews(source) {
  const pattern = new RegExp(
    String.raw`^\s*const\s+${STATIC_IDENTIFIER_TOKEN}\s*=\s*\[([\s\S]*?)\]\s*;\s*const\s+${STATIC_IDENTIFIER_TOKEN}\s*=\s*await\s+Promise\.all\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\.map\s*\(\s*${STATIC_IDENTIFIER_TOKEN}\s*=>\s*tools\.view_image\s*\(\s*\{\s*(?:path|["']path["'])(?:\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*))?(?:\s*,\s*(?:detail|["']detail["'])\s*:\s*${STATIC_STRING_TOKEN})?\s*,?\s*\}\s*\)\s*\)\s*\)\s*;\s*([A-Za-z_$][A-Za-z0-9_$]*)\.forEach\s*\(\s*\(\s*${STATIC_IDENTIFIER_TOKEN}\s*,\s*${STATIC_IDENTIFIER_TOKEN}\s*\)\s*=>\s*\{\s*(?:text\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\[\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\]\s*\)\s*;?\s*)?image\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\.image_url(?:\s*,\s*${STATIC_STRING_TOKEN})?\s*\)\s*;?\s*\}\s*\)\s*;?\s*$`,
  );
  const match = source.match(pattern);
  if (!match) return undefined;
  const [arrayName, arrayBody, resultsName, mappedArray, itemName, pathName,
    consumedResults, resultItem, indexName, labelArray, labelIndex, consumedItem] = match.slice(1);
  if (mappedArray !== arrayName || (pathName || itemName) !== itemName || consumedResults !== resultsName
    || consumedItem !== resultItem || (labelArray && labelArray !== arrayName)
    || (labelIndex && labelIndex !== indexName)) return undefined;
  return readStaticStringArray(arrayBody);
}

function exactMappedForOfImageViews(source) {
  const pattern = new RegExp(
    String.raw`^\s*const\s+${STATIC_IDENTIFIER_TOKEN}\s*=\s*\[([\s\S]*?)\]\.map\s*\(\s*${STATIC_IDENTIFIER_TOKEN}\s*=>\s*(${STATIC_TEMPLATE_TOKEN})\s*\)\s*;\s*for\s*\(\s*const\s+${STATIC_IDENTIFIER_TOKEN}\s+of\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\)\s*\{\s*const\s+${STATIC_IDENTIFIER_TOKEN}\s*=\s*await\s+tools\.view_image\s*\(\s*\{\s*(?:path|["']path["'])\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*,\s*(?:detail|["']detail["'])\s*:\s*${STATIC_STRING_TOKEN})?\s*,?\s*\}\s*\)\s*;?\s*image\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\.image_url(?:\s*,\s*${STATIC_STRING_TOKEN})?\s*\)\s*;?\s*\}\s*;?\s*$`,
  );
  const match = source.match(pattern);
  if (!match) return undefined;
  const [arrayName, arrayBody, mapItem, template, loopItem, loopArray,
    resultItem, pathItem, consumedResult] = match.slice(1);
  if (loopArray !== arrayName || pathItem !== loopItem || consumedResult !== resultItem) return undefined;
  const values = readStaticStringArray(arrayBody);
  return values ? expandStaticTemplate(template, mapItem, values) : undefined;
}

function extractStaticImageViewPaths(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_EXEC_SOURCE_CHARS) return null;
  const source = stripExactExecPragma(input);
  if (source === undefined) return null;
  const values = exactSingleImageView(source) || exactArrayImageViews(source) || exactMappedForOfImageViews(source);
  if (!values || values.length === 0 || values.length > MAX_EXEC_IMAGES) return null;
  return values.slice();
}

module.exports = {
  MAX_EXEC_COMMANDS,
  MAX_EXEC_IMAGES,
  MAX_EXEC_SOURCE_CHARS,
  extractStaticImageViewPaths,
  extractExactApplyPatch,
  extractShellCommands,
  extractSingleShellCommand,
  isExactApplyPatchWrapper,
};
