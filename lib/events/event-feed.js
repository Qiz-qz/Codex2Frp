'use strict';

const {
  cloneWithPrivateAttachmentSources,
  privateAttachmentSourceDigest,
} = require('./private-attachment-source');

function eventOrder(value) {
  const order = Number(value && value.order);
  return Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER;
}

function clone(value) {
  return cloneWithPrivateAttachmentSources(value);
}

function eventMeaning(value) {
  if (!value || typeof value !== 'object') return '';
  const { cursor: _cursor, order: _order, source: _source, sourceOrdinal: _sourceOrdinal, ...meaning } = value;
  return JSON.stringify({ meaning, privateAttachmentSource: privateAttachmentSourceDigest(meaning) });
}

const DEFAULT_MAX_CHANGES = 8192;

class EventFeed {
  constructor(options = {}) {
    this.serverInstanceId = String(options.serverInstanceId || '').trim();
    if (!this.serverInstanceId) throw new TypeError('EventFeed requires serverInstanceId.');
    this.snapshotVersion = Number.isSafeInteger(options.snapshotVersion) && options.snapshotVersion > 0
      ? options.snapshotVersion
      : 1;
    this.maxChanges = Number.isSafeInteger(options.maxChanges) && options.maxChanges > 0
      ? options.maxChanges
      : DEFAULT_MAX_CHANGES;
    this.cursor = 0;
    this.events = [];
    this.changes = [];
    this.turnRevisions = new Map();
    this.seenEventIds = new Set();
    this.sourceOrdinals = new Map();
    this.nextSourceOrdinal = 0;
  }

  publish(values) {
    const rows = (Array.isArray(values) ? values : [])
      .filter(value => value && typeof value === 'object' && String(value.eventId || '').trim())
      .map(value => {
        const row = clone(value);
        row.eventId = String(row.eventId);
        if (!this.sourceOrdinals.has(row.eventId)) {
          this.sourceOrdinals.set(row.eventId, ++this.nextSourceOrdinal);
        }
        row.sourceOrdinal = this.sourceOrdinals.get(row.eventId);
        return row;
      })
      .sort((left, right) => eventOrder(left) - eventOrder(right)
        || left.sourceOrdinal - right.sourceOrdinal);
    const accepted = [];
    for (const row of rows) {
      row.eventId = String(row.eventId);
      if (this.seenEventIds.has(row.eventId)) {
        const existingIndex = this.events.findIndex(event => event.eventId === row.eventId);
        const existing = existingIndex >= 0 ? this.events[existingIndex] : null;
        if (!existing || eventMeaning(existing) === eventMeaning(row)) continue;
        row.cursor = ++this.cursor;
        this.events[existingIndex] = row;
        this.changes.push(clone(row));
        this.trimChanges();
        this.recordTurnRevision(row);
        accepted.push(clone(row));
        continue;
      }
      this.seenEventIds.add(row.eventId);
      row.cursor = ++this.cursor;
      this.events.push(row);
      this.changes.push(clone(row));
      this.trimChanges();
      this.recordTurnRevision(row);
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
        .sort((left, right) => eventOrder(left) - eventOrder(right)
          || left.sourceOrdinal - right.sourceOrdinal)
        .map(clone),
    };
  }

  read(request = {}) {
    const instanceMatches = String(request.serverInstanceId || '') === this.serverInstanceId;
    const snapshotMatches = Number(request.snapshotVersion) === this.snapshotVersion;
    if (!instanceMatches || !snapshotMatches) return this.snapshot();
    const cursor = Number.isSafeInteger(request.cursor) && request.cursor >= 0 ? request.cursor : 0;
    if (cursor > this.cursor) return this.snapshot();
    // The compact snapshot keeps only the latest revision of each stable
    // event. Delta readers still need every cursor revision; otherwise two
    // reasoning updates between polls look like a cursor gap and force a huge
    // full snapshot on every refresh.
    const deltaEvents = this.changes
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

  trimChanges() {
    if (this.changes.length <= this.maxChanges) return;
    this.changes.splice(0, this.changes.length - this.maxChanges);
  }

  recordTurnRevision(event) {
    const turnId = String(event && event.turnId || '').trim();
    if (!turnId || !Number.isSafeInteger(event.cursor) || event.cursor <= 0) return;
    this.turnRevisions.set(turnId, event.cursor);
  }

  turnRevision(turnIdValue) {
    const turnId = String(turnIdValue || '').trim();
    const cursor = this.turnRevisions.get(turnId);
    return Number.isSafeInteger(cursor) && cursor > 0
      ? `v${this.snapshotVersion}-c${cursor}`
      : '';
  }

  removeEventIds(values) {
    const ids = new Set((Array.isArray(values) ? values : [])
      .map(value => String(value || '').trim())
      .filter(Boolean));
    if (!ids.size || !this.events.some(event => ids.has(event.eventId))) return false;
    const remaining = this.events.filter(event => !ids.has(event.eventId));
    this.replaceSnapshot(remaining);
    return true;
  }

  replaceSnapshot(values) {
    this.snapshotVersion += 1;
    this.cursor = 0;
    this.events = [];
    this.changes = [];
    this.turnRevisions.clear();
    this.seenEventIds.clear();
    this.sourceOrdinals.clear();
    this.nextSourceOrdinal = 0;
    this.publish(values);
    return this.snapshot();
  }
}

module.exports = {
  EventFeed,
};
