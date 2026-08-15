const path = require("node:path");
const { CdbBridgeClient } = require("./bridge-client");
const { resolveInterface } = require("./sofistik-interface");

class CdbDatabase {
  constructor(databasePath, options = {}) {
    if (typeof databasePath !== "string" || path.extname(databasePath).toLowerCase() !== ".cdb") {
      throw new RangeError("SOFiSTiK databases require a .cdb path.");
    }
    this.databasePath = path.resolve(databasePath);
    const runtime = resolveInterface(options);
    this.version = runtime.version;
    this.edition = runtime.edition;
    this.installRoot = runtime.installRoot;
    this.dllPath = runtime.dllPath;
    this.bridge = options.bridge || null;
    this.bridgeFactory = options.bridgeFactory || (() => new CdbBridgeClient(options));
    this.ownsBridge = !options.bridge;
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

  open() {
    this.ensureActive();
    this.openPromise ||= this.getBridge().request("open", {
      payload: {
        databasePath: this.databasePath,
        dllPath: this.dllPath,
        installRoot: this.installRoot,
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
    const readerId = await this.open();
    return this.getBridge().request("records", {
      readerId,
      payload: { name, secondary, partial: Boolean(options.partial) },
    });
  }

  // The secondary keys a record kind is stored under - the load case numbers, the
  // section numbers - so a caller can iterate what a database actually holds.
  async keys(name) {
    this.ensureActive();
    const readerId = await this.open();
    return this.getBridge().request("keys", { readerId, payload: { name } });
  }

  dispose() {
    if (this.disposed) return this.disposePromise;
    this.disposed = true;
    const openPromise = this.openPromise;
    this.openPromise = null;
    const release = () => {
      if (this.ownsBridge) this.bridge?.dispose();
      this.bridge = null;
    };
    if (!openPromise) {
      release();
      this.disposePromise = Promise.resolve();
      return this.disposePromise;
    }
    this.disposePromise = openPromise
      .then((readerId) => this.bridge?.request("close", { readerId }))
      .catch(() => {})
      .finally(release);
    return this.disposePromise;
  }
}

module.exports = { CdbDatabase };
