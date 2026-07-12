'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { AppServerProcessManager } = require('./process-manager');
const { validateSchemaProfile } = require('./schema-profile');
const { CodexService } = require('../codex/codex-service');
const { createCapabilityManifest } = require('../codex/capabilities');
const { AppServerConnectionClosedError } = require('../codex/errors');

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function codexHomeFingerprint(codexHome) {
  const normalized = path.win32.normalize(String(codexHome || '').trim()).toLowerCase();
  const digest = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
  return `sha256:${digest}`;
}

class AppServerRuntime {
  constructor(options = {}) {
    this.schemaProfile = validateSchemaProfile(options.schemaProfile || options.profile);
    this.codexHome = String(options.codexHome || '').trim();
    if (!path.win32.isAbsolute(this.codexHome)) {
      throw new TypeError('AppServerRuntime requires an absolute Windows codexHome.');
    }

    this.processManager = options.processManager || new AppServerProcessManager(options.processOptions);
    if (!this.processManager || typeof this.processManager.start !== 'function') {
      throw new TypeError('AppServerRuntime requires an app-server process manager.');
    }
    this.createService = typeof options.createService === 'function'
      ? options.createService
      : serviceOptions => new CodexService(serviceOptions);
    this.commandCoordinator = options.commandCoordinator;
    this.protectedThreadGuard = options.protectedThreadGuard || options.guard;
    this.initializeParams = copy(options.initializeParams || {});
    this.notificationSink = typeof options.notificationSink === 'function'
      ? options.notificationSink
      : null;
    this.serverRequestSink = typeof options.serverRequestSink === 'function'
      ? options.serverRequestSink
      : null;
    this.notificationClient = null;
    this.notificationListener = null;
    this.serverRequestListener = null;
    this.versions = Object.freeze({
      backend: String(options.backendVersion || ''),
      desktop: String(options.desktopVersion || ''),
      cli: String(options.cliVersion || this.schemaProfile.schemaVersion),
    });
    this.fingerprint = String(options.codexHomeFingerprint || codexHomeFingerprint(this.codexHome));
    this.capabilityOptions = {
      profile: this.schemaProfile,
      supportedMethods: Array.isArray(options.supportedMethods)
        ? [...options.supportedMethods]
        : [...this.schemaProfile.requiredRequestMethods],
      bridgeOperations: Array.isArray(options.bridgeOperations) ? [...options.bridgeOperations] : [],
      uiExplicitOperations: Array.isArray(options.uiExplicitOperations) ? [...options.uiExplicitOperations] : [],
      unavailableOperations: options.unavailableOperations,
      codexHomeFingerprint: this.fingerprint,
    };

    this.state = 'stopped';
    this.pid = null;
    this.connectionEpoch = 0;
    this.service = null;
    this.startPromise = null;
    this.activeStart = null;
    this.lifecycleGeneration = 0;

    if (typeof this.processManager.on === 'function') {
      this.processManager.on('exit', event => this.handleExit(event));
      this.processManager.on('processError', event => this.handleExit(event));
    }
  }

  getMeta() {
    return {
      apiVersion: 3,
      versions: { ...this.versions },
      protocol: {
        profile: this.schemaProfile.id,
        schemaVersion: this.schemaProfile.schemaVersion,
        schemaHash: this.schemaProfile.schema.sha256,
      },
      codexHomeFingerprint: this.fingerprint,
      appServer: {
        state: this.state,
        pid: this.pid,
        connectionEpoch: this.connectionEpoch,
      },
      capabilities: createCapabilityManifest(this.capabilityOptions),
    };
  }

  ensureStarted() {
    if (this.service && this.state === 'ready') return Promise.resolve(this.service);
    if (this.startPromise) return this.startPromise;
    if (this.state === 'stopping') {
      return Promise.reject(new AppServerConnectionClosedError({
        connectionEpoch: this.connectionEpoch,
      }));
    }

    this.state = 'starting';
    const lifecycleGeneration = ++this.lifecycleGeneration;
    const startPromise = this.startOwnedService(lifecycleGeneration);
    this.startPromise = startPromise;
    return startPromise.finally(() => {
      if (this.startPromise === startPromise) this.startPromise = null;
    });
  }

  async startOwnedService(lifecycleGeneration) {
    let started;
    try {
      started = this.processManager.start({ codexHome: this.codexHome });
      this.pid = started.pid;
      this.connectionEpoch = started.connectionEpoch;
      this.attachNotificationClient(started.client);
      const activeStart = {
        pid: started.pid,
        connectionEpoch: started.connectionEpoch,
        lifecycleGeneration,
      };
      this.activeStart = activeStart;
      const service = this.createService({
        rpcClient: started.client,
        schemaProfile: this.schemaProfile,
        codexHome: this.codexHome,
        commandCoordinator: this.commandCoordinator,
        protectedThreadGuard: this.protectedThreadGuard,
      });
      if (!service || typeof service.initialize !== 'function') {
        throw new TypeError('AppServerRuntime createService must return an initializable Codex service.');
      }
      await service.initialize(copy(this.initializeParams));
      if (this.activeStart !== activeStart
        || this.lifecycleGeneration !== lifecycleGeneration
        || this.state !== 'starting') {
        throw new AppServerConnectionClosedError({
          pid: started.pid,
          connectionEpoch: started.connectionEpoch,
        });
      }
      this.service = service;
      this.state = 'ready';
      return service;
    } catch (error) {
      if (this.lifecycleGeneration === lifecycleGeneration) {
        this.detachNotificationClient();
        if (started && this.activeStart && typeof this.processManager.stop === 'function') {
          this.processManager.stop('SIGTERM');
        }
        this.service = null;
        this.pid = null;
        this.state = 'stopped';
        this.activeStart = null;
      }
      throw error;
    }
  }

  async withService(operation) {
    if (typeof operation !== 'function') {
      throw new TypeError('AppServerRuntime.withService requires an operation callback.');
    }
    const service = await this.ensureStarted();
    return operation(service, this.getMeta());
  }

  attachNotificationClient(client) {
    this.detachNotificationClient();
    if ((!this.notificationSink && !this.serverRequestSink)
      || !client || typeof client.on !== 'function') return false;
    this.notificationClient = client;
    if (this.notificationSink) {
      this.notificationListener = notification => {
        try {
          Promise.resolve(this.notificationSink(notification)).catch(() => {});
        } catch {}
      };
      client.on('notification', this.notificationListener);
    }
    if (this.serverRequestSink) {
      this.serverRequestListener = request => {
        const requestEpoch = Number(request && request.connectionEpoch);
        if (this.notificationClient !== client
          || !Number.isSafeInteger(requestEpoch)
          || requestEpoch <= 0
          || requestEpoch !== this.connectionEpoch) return;
        const forwarded = {
          method: String(request.method || ''),
          params: copy(request.params),
          connectionEpoch: requestEpoch,
          respond: result => this.respondServerRequest(request.id, result, {
            client,
            connectionEpoch: requestEpoch,
          }),
        };
        try {
          Promise.resolve(this.serverRequestSink(forwarded)).catch(() => {});
        } catch {}
      };
      client.on('serverRequest', this.serverRequestListener);
    }
    return true;
  }

  respondServerRequest(id, result, options = {}) {
    const client = options.client || this.notificationClient;
    const requestEpoch = Number(options.connectionEpoch);
    if (!client
      || client !== this.notificationClient
      || !['starting', 'ready'].includes(this.state)
      || !Number.isSafeInteger(requestEpoch)
      || requestEpoch <= 0
      || requestEpoch !== this.connectionEpoch
      || typeof client.respondServerRequest !== 'function') {
      throw new AppServerConnectionClosedError({
        connectionEpoch: this.connectionEpoch,
      });
    }
    return client.respondServerRequest(id, copy(result), { connectionEpoch: requestEpoch });
  }

  detachNotificationClient() {
    if (!this.notificationClient) return false;
    if (typeof this.notificationClient.removeListener === 'function') {
      if (this.notificationListener) {
        this.notificationClient.removeListener('notification', this.notificationListener);
      }
      if (this.serverRequestListener) {
        this.notificationClient.removeListener('serverRequest', this.serverRequestListener);
      }
    }
    this.notificationClient = null;
    this.notificationListener = null;
    this.serverRequestListener = null;
    return true;
  }

  stop(signal = 'SIGTERM') {
    if (this.state === 'stopped' || typeof this.processManager.stop !== 'function') return false;
    const connectionEpoch = this.connectionEpoch;
    const stopped = this.processManager.stop(signal);
    if (!stopped) return false;
    this.lifecycleGeneration += 1;
    this.activeStart = null;
    this.service = null;
    this.detachNotificationClient();
    if (this.state !== 'stopped' && this.connectionEpoch === connectionEpoch) {
      this.state = 'stopping';
    }
    return true;
  }

  handleExit(event = {}) {
    const epoch = Number(event.connectionEpoch) || 0;
    if (!epoch || epoch !== this.connectionEpoch) return;
    this.lifecycleGeneration += 1;
    this.detachNotificationClient();
    this.activeStart = null;
    this.service = null;
    this.pid = null;
    this.state = 'stopped';
  }
}

module.exports = {
  AppServerRuntime,
  codexHomeFingerprint,
};
