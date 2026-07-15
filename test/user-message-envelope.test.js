'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUserMessageEnvelope } = require('../lib/events/user-message-envelope');

test('new file wrapper exposes only request text and safe basenames', () => {
  const result = parseUserMessageEnvelope([
    '# Files mentioned by the user:',
    '',
    '## report image.png: C:/private/reports/report image.png',
    '',
    '## My request for Codex:',
    '请分析这张图片。',
  ].join('\n'));
  assert.equal(result.text, '请分析这张图片。');
  assert.deepEqual(result.attachmentNames, ['report image.png']);
  assert.equal(result.recognized, true);
  assert.equal(JSON.stringify(result).includes('C:/private'), false);
});

test('file wrapper preserves two different sources that share one safe basename', () => {
  const result = parseUserMessageEnvelope([
    '# Files mentioned by the user:',
    '## same.png: E:/ProtocolFixtures/first/same.png',
    '## same.png: E:/ProtocolFixtures/second/same.png',
    '## My request for Codex:',
    '比较两张图片',
  ].join('\n'));

  assert.deepEqual(result.attachmentNames, ['same.png', 'same.png']);
  assert.equal(JSON.stringify(result).includes('ProtocolFixtures'), false);
});

test('incomplete file wrapper fails closed without exposing a path', () => {
  const result = parseUserMessageEnvelope('# Files mentioned by the user:\n## x.txt: C:/secret/x.txt');
  assert.deepEqual(result, { text: '', attachmentNames: ['x.txt'], recognized: true, malformed: true });
});

test('ordinary prose mentioning the request heading is unchanged', () => {
  const text = '正文中提到 My request for Codex 不代表这是包装。';
  assert.equal(parseUserMessageEnvelope(text).text, text);
});

test('file wrapper header must end at a line boundary', () => {
  const text = '# Files mentioned by the user: this is ordinary prose';
  assert.deepEqual(parseUserMessageEnvelope(text), {
    text,
    attachmentNames: [],
    recognized: false,
    malformed: false,
  });
});

test('legacy referenced-image suffix is recognized only at a complete line boundary', () => {
  const result = parseUserMessageEnvelope('inspect this\n\nReferenced image files:\n- [Image #1]: C:\\secret\\one.png');
  assert.equal(result.text, 'inspect this');
  assert.deepEqual(result.attachmentNames, ['one.png']);
  assert.equal(JSON.stringify(result).includes('C:\\secret'), false);
  const prose = 'ordinary prose Referenced image files:\n- not an envelope';
  assert.equal(parseUserMessageEnvelope(prose).text, prose);
});

test('legacy image tags are anchored, strip complete blocks, and malformed blocks fail closed', () => {
  const complete = parseUserMessageEnvelope('inspect this\n\n<image name=[Image #1] path="C:\\secret\\one.png">\n</image>');
  assert.equal(complete.text, 'inspect this');
  assert.deepEqual(complete.attachmentNames, ['one.png']);
  const malformed = parseUserMessageEnvelope('inspect this\n\n<image name=[Image #1] path="C:\\secret\\one.png">');
  assert.deepEqual(malformed, { text: '', attachmentNames: ['one.png'], recognized: true, malformed: true });
  const prose = 'say <image name=[Image #1] path="C:\\secret\\one.png"> aloud';
  assert.equal(parseUserMessageEnvelope(prose).text, prose);
});
