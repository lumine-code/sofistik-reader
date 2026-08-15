const path = require("node:path");
const { fork } = require("node:child_process");

class CdbBridgeClient {
  constructor(options = {}) {
    const forkProcess = options.fork || fork;
    this.child = forkProcess(options.workerPath || path.join(__dirname, "cdb-worker.js"), [], {
      execPath: options.execPath || process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      serialization: "advanced",
      silent: true,
    });
    this.pending = new Map();
    this.nextRequestId = 1;
    this.disposed = false;
    this.stderr = "";
    this.child.on("message", (message) => this.receive(message));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code) => {
      if (!this.disposed) this.fail(new Error(this.exitMessage(code)));
    });
    this.child.stderr?.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-16384);
    });
  }

  exitMessage(code) {
    const detail = this.stderr.trim();
    return `The SOFiSTiK CDB process stopped with exit code ${code}.${detail ? ` ${detail}` : ""}`;
  }

  request(operation, { readerId, payload } = {}) {
    if (this.disposed) return Promise.reject(new Error("The SOFiSTiK CDB process is closed."));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ id, operation, readerId, payload }, (error) => {
        if (!error) return;
        this.pending.get(id)?.reject(error);
        this.pending.delete(id);
      });
    });
  }

  receive({ id, value, error }) {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    if (error) {
      const failure = new Error(error.message);
      failure.name = error.name || "Error";
      request.reject(failure);
    } else request.resolve(value);
  }

  fail(error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.fail(new Error("The SOFiSTiK CDB process was closed."));
    this.child.kill();
  }
}

module.exports = { CdbBridgeClient };
