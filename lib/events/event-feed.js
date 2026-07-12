'use strict';

function eventOrder(value) {
  const order = Number(value && value.order);
  return Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER;
}

function clone(value) {
  return structuredClone(value);
}

function eventMeaning(value) {
  if (!value || typeof value !== 'object') return '';
  const { cursor: _cursor, order: _order, source: _source, ...meaning } = value;
  return JSON.stringify(meaning);
}

class EventFeed {
  constructor(options = {}) {
    this.serverInstanceId = String(options.serverInstanceId || '').trim();
    if (!this.serverInstanceId) throw new TypeError('EventFeed requires serverInstanceId.');
    this.snapshotVersion = Number.isSafeInteger(options.snapshotVersion) && options.snapshotVersion > 0
      ? options.snapshotVersion
      : 1;
    this.cursor = 0;
    this.events = [];
    this.seenEventIds = new Set();
  }

  publish(values) {
    const rows = (Array.isArray(values) ? values : [])
      .filter(value => value && typeof value === 'object' && String(value.eventId || '').trim())
      .map(value => clone(value))
      .sort((left, right) => eventOrder(left) - eventOrder(right)
        || String(left.eventId).localeCompare(String(right.eventId)));
    const accepted = [];
    for (const row of rows) {
      row.eventId = String(row.eventId);
      if (this.seenEventIds.has(row.eventId)) {
        const existingIndex = this.events.findIndex(event => event.eventId === row.eventId);
        const existing = existingIndex >= 0 ? this.events[existingIndex] : null;
        if (!existing || eventMeaning(existing) === eventMeaning(row)) continue;
        row.cursor = ++this.cursor;
        this.events[existingIndex] = row;
        accepted.push(clone(row));
        continue;
      }
      this.seenEventIds.add(row.eventId);
      row.cursor = ++this.cursor;
      this.events.push(row);
      accepted.push(clone(row));
    }
    return accepted;
  }

  snapshot() {
    return {
      mode: 'snapshot',
      serverInstanceId: this.serverInstanceId,
      snapshotVersion: this.snapshotVersion,
      cursor: this.cursor,
      events: this.events
        .slice()
        .sort((left, right) => eventOrder(left) - eventOrder(right) || left.cursor - right.cursor)
        .map(clone),
    };
  }

  read(request = {}) {
    const instanceMatches = String(request.serverInstanceId || '') === this.serverInstanceId;
    const snapshotMatches = Number(request.snapshotVersion) === this.snapshotVersion;
    if (!instanceMatches || !snapshotMatches) return this.snapshot();
    const cursor = Number.isSafeInteger(request.cursor) && request.cursor >= 0 ? request.cursor : 0;
    if (cursor > this.cursor) return this.snapshot();
    const deltaEvents = this.events
      .filter(event => event.cursor > cursor)
      .sort((left, right) => left.cursor - right.cursor);
    let expectedCursor = cursor + 1;
    for (const event of deltaEvents) {
      if (event.cursor !== expectedCursor) return this.snapshot();
      expectedCursor += 1;
    }
    if (expectedCursor - 1 !== this.cursor) return this.snapshot();
    return {
      mode: 'delta',
      serverInstanceId: this.serverInstanceId,
      snapshotVersion: this.snapshotVersion,
      cursor: this.cursor,
      events: deltaEvents.map(clone),
    };
  }

  replaceSnapshot(values) {
    this.snapshotVersion += 1;
    this.cursor = 0;
    this.events = [];
    this.seenEventIds.clear();
    this.publish(values);
    return this.snapshot();
  }
}

module.exports = {
  EventFeed,
};
