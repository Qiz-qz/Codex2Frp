'use strict';

class CommandCoordinator {
  constructor(options = {}) {
    if (!options.guard || typeof options.guard.assertAllowed !== 'function') {
      throw new TypeError('CommandCoordinator requires a protected thread guard.');
    }
    this.guard = options.guard;
    this.tails = new Map();
  }

  async run(context, operation) {
    if (typeof operation !== 'function') {
      throw new TypeError('CommandCoordinator operation must be a function.');
    }
    const checked = this.guard.assertAllowed(context);
    if (checked.mode === 'read') {
      return operation(checked);
    }

    const key = checked.threadId || `global:${checked.action}`;
    const previous = this.tails.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => operation(checked));
    const tail = current.catch(() => {});
    this.tails.set(key, tail);

    try {
      return await current;
    } finally {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }

  pendingKeys() {
    return [...this.tails.keys()];
  }
}

module.exports = {
  CommandCoordinator,
};
