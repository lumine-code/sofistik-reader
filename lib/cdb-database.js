const path = require("node:path");
const { CdbBridgeClient } = require("./bridge-client");
const { resolveInterface } = require("./sofistik-interface");
const { validateDecodePolicy } = require("./record-policy");

class CdbDatabase {
  constructor(databasePath, options = {}) {
    if (typeof databasePath !== "string" || path.extname(databasePath).toLowerCase() !== ".cdb") {
      throw new RangeError("SOFiSTiK databases require a .cdb path.");
    }
    this.databasePath = path.resolve(databasePath);
    const runtime = resolveInterface(options);
    this.version = runtime.version;
    this.edition = runtime.edition;
    this.environmentRoot = runtime.environmentRoot;
    this.installRoot = runtime.installRoot;
    this.dllPath = runtime.dllPath;
    this.bridge = options.bridge || null;
    this.bridgeFactory = options.bridgeFactory || (() => new CdbBridgeClient(options));
    this.ownsBridge = !options.bridge;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2000;
    this.openPromise = null;
    this.disposePromise = null;
    this.disposed = false;
  }

  ensureActive() {
    if (this.disposed) throw new Error("The SOFiSTiK CDB database is closed.");
  }

  getBridge() {
    this.bridge ||= this.bridgeFactory();
    return this.bridge;
  }

  open(options = {}) {
    this.ensureActive();
    this.openPromise ||= this.getBridge().request("open", {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      payload: {
        databasePath: this.databasePath,
        dllPath: this.dllPath,
        environmentRoot: this.environmentRoot,
        installRoot: this.installRoot,
        version: this.version,
      },
    });
    return this.openPromise;
  }

  // Reads one record kind from the catalog. `secondary` is the load case,
  // section or material number the record is stored under, when the key does not
  // fix it. Nothing is cached here: a caller that wants a result twice is better
  // placed to decide how long to hold it.
  async read(name, secondary, options = {}) {
    this.ensureActive();
    const decodePolicy = validateDecodePolicy(options.decodePolicy);
    const readerId = await this.open(options);
    this.ensureActive();
    return this.getBridge().request("records", {
      readerId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      payload: { name, secondary, decodePolicy },
    });
  }

  // The secondary keys a record kind is stored under - the load case numbers, the
  // section numbers - so a caller can iterate what a database actually holds.
  async keys(name, options = {}) {
    this.ensureActive();
    const readerId = await this.open(options);
    this.ensureActive();
    return this.getBridge().request("keys", {
      readerId,
      payload: { name },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  }

  dispose() {
    if (this.disposed) return this.disposePromise;
    this.disposed = true;
    const openPromise = this.openPromise;
    this.openPromise = null;
    const bridge = this.bridge;
    const release = async () => {
      if (this.ownsBridge) await bridge?.dispose();
      this.bridge = null;
    };
    if (!openPromise) {
      this.disposePromise = release();
      return this.disposePromise;
    }
    let timer;
    const close = openPromise
      .then((readerId) => bridge?.request("close", { readerId, timeoutMs: this.shutdownTimeoutMs }))
      .catch(() => {});
    this.disposePromise = Promise.race([
      close,
      new Promise((resolve) => {
        timer = setTimeout(resolve, this.shutdownTimeoutMs);
      }),
    ]).finally(async () => {
      clearTimeout(timer);
      await release();
    });
    return this.disposePromise;
  }
}

module.exports = { CdbDatabase };
