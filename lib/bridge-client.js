const path = require("node:path");
const { fork } = require("node:child_process");

class CdbBridgeClient {
  constructor(options = {}) {
    const forkProcess = options.fork || fork;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2000;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.failure = null;
    this.disposed = false;
    this.disposePromise = null;
    this.stderr = "";
    this.exited = false;
    this.child = forkProcess(options.workerPath || path.join(__dirname, "cdb-worker.js"), [], {
      execPath: options.execPath || process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      serialization: "advanced",
      silent: true,
    });
    this.child.on("message", (message) => this.receive(message));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("disconnect", () => {
      if (!this.disposed) this.fail(new Error("The SOFiSTiK CDB process disconnected."));
    });
    this.child.on("exit", (code) => {
      this.exited = true;
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

  request(operation, { readerId, payload, signal, timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.disposed) return Promise.reject(new Error("The SOFiSTiK CDB process is closed."));
    if (signal?.aborted)
      return Promise.reject(signal.reason || new DOMException("Cancelled", "AbortError"));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      return Promise.reject(new RangeError("A CDB request deadline must be positive."));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const abort = () => this.fail(signal.reason || new DOMException("Cancelled", "AbortError"));
      const timer = setTimeout(() => {
        const error = new Error(`The SOFiSTiK CDB ${operation} request exceeded ${timeoutMs} ms.`);
        error.code = "ERR_CDB_TIMEOUT";
        this.fail(error);
      }, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        cleanup() {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        },
      });
      try {
        this.child.send({ id, operation, readerId, payload }, (error) => {
          if (error) this.fail(error);
        });
      } catch (error) {
        this.fail(error);
      }
    });
  }

  receive({ id, value, error }) {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    request.cleanup();
    if (error) {
      const Type = { Error, RangeError, TypeError }[error.name] || Error;
      const failure = new Type(error.message);
      failure.name = error.name || "Error";
      if (error.code) failure.code = error.code;
      request.reject(failure);
    } else request.resolve(value);
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) {
      request.cleanup();
      request.reject(error);
    }
    this.pending.clear();
    if (!this.exited) this.child.kill();
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.fail(new Error("The SOFiSTiK CDB process was closed."));
    if (this.exited) return (this.disposePromise = Promise.resolve());
    this.disposePromise = new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.child.removeListener("exit", finish);
        resolve();
      };
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        finish();
      }, this.shutdownTimeoutMs);
      this.child.once("exit", finish);
    });
    return this.disposePromise;
  }
}

module.exports = { CdbBridgeClient };
