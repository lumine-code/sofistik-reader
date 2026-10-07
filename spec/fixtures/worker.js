const { serveWorker } = require("../../lib/worker-runtime");
serveWorker(process, () => ({
  read({ name }) {
    // This fixture deliberately crashes to exercise the parent failure boundary.
    // eslint-disable-next-line n/no-process-exit
    if (name === "crash") process.exit(23);
    if (name === "block") {
      for (;;) {
        /* A native call cannot service IPC. */
      }
    }
    if (name === "invalid") {
      const error = new RangeError("Unsupported record");
      error.code = "ERR_CDB_RECORD_UNAVAILABLE";
      throw error;
    }
    return { count: 1, columns: { nr: Int32Array.of(7), xyz: Float32Array.of(1, 2, 3) } };
  },
  keys() {
    return Int32Array.of(101, 102);
  },
  close() {},
}));
