'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeAdjacentUserHistoryMessage } = require('../lib/events/history-user-pair');

test('legacy history merges complementary desktop user representations despite different attachment counts', () => {
  const previous = {
    text: '检查附件', attachments: ['a.png', 'spec.txt'], representation: 'response_item',
    turnId: 'turn-steer', delivery: 'steer', timestamp: '2026-07-10T10:00:00.000Z',
  };
  const next = {
    text: '检查附件', attachments: ['C:/private/a.png'], representation: 'event_msg',
    timestamp: '2026-07-10T10:00:00.001Z',
  };

  const result = mergeAdjacentUserHistoryMessage(previous, next);
  assert.equal(result.duplicate, true);
  assert.equal(result.message.representation, 'response_item');
  assert.equal(result.message.turnId, 'turn-steer');
  assert.equal(result.message.delivery, 'steer');
  assert.deepEqual(result.message.attachments, ['C:/private/a.png', 'spec.txt']);
});

test('legacy history pairs name-only wrapper rows by ordinal but preserves different same-basename sources', () => {
  const previous = {
    text: '比较图片', attachments: ['same.png', 'same.png'], representation: 'response_item',
    timestamp: '2026-07-10T10:05:00.000Z',
  };
  const next = {
    text: '比较图片',
    attachments: ['C:/fixtures/first/same.png', 'C:/fixtures/second/same.png'],
    representation: 'event_msg', timestamp: '2026-07-10T10:05:00.001Z',
  };

  const result = mergeAdjacentUserHistoryMessage(previous, next);
  assert.equal(result.duplicate, true);
  assert.deepEqual(result.message.attachments, next.attachments);
});

test('paired ChatGPT inline image representations remain one canonical image per ordinal', () => {
  const eventCopy = {
    text: '图片', attachments: [{ name: 'image-1', dataUrl: 'data:image/png;base64,event-copy' }],
    representation: 'event_msg', timestamp: '2026-07-17T10:05:00.000Z',
  };
  const canonical = {
    text: '图片', attachments: [{ name: 'image-1', dataUrl: 'data:image/png;base64,canonical-copy' }],
    representation: 'response_item', timestamp: '2026-07-17T10:05:00.001Z',
  };

  const result = mergeAdjacentUserHistoryMessage(eventCopy, canonical);
  assert.equal(result.duplicate, true);
  assert.deepEqual(result.message.attachments, canonical.attachments);
});

test('legacy history never collapses independent same-text records from the same representation', () => {
  const previous = {
    text: '确认', attachments: [], representation: 'response_item', recordId: 'user-1',
    timestamp: '2026-07-10T10:00:00.000Z',
  };
  const next = {
    text: '确认', attachments: [], representation: 'response_item', recordId: 'user-2',
    timestamp: '2026-07-10T10:00:00.500Z',
  };

  const result = mergeAdjacentUserHistoryMessage(previous, next);
  assert.equal(result.duplicate, false);
  assert.equal(result.message.recordId, 'user-2');
});

test('legacy history pairing requires adjacency, matching text, and a tight timestamp window', () => {
  const response = {
    text: '第一条', attachments: [], representation: 'response_item',
    timestamp: '2026-07-10T10:00:00.000Z',
  };
  const differentText = {
    text: '第二条', attachments: [], representation: 'event_msg',
    timestamp: '2026-07-10T10:00:00.001Z',
  };
  const lateFallback = {
    text: '第一条', attachments: [], representation: 'event_msg',
    timestamp: '2026-07-10T10:00:02.000Z',
  };

  assert.equal(mergeAdjacentUserHistoryMessage(response, differentText).duplicate, false);
  assert.equal(mergeAdjacentUserHistoryMessage(response, lateFallback).duplicate, false);
});
