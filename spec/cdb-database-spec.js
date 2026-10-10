const path = require("node:path");
const { CdbDatabase, openDatabase } = require("../lib");

function fixture() {
  const requests = [];
  const bridge = {
    disposed: false,
    async request(operation, options) {
      requests.push({ operation, options });
      if (operation === "open") return 17;
      if (operation === "records") return { name: options.payload.name, count: 2, columns: {} };
      if (operation === "keys") return Int32Array.from([101, 102]);
      return true;
    },
    dispose() {
      this.disposed = true;
    },
  };
  let factoryCalls = 0;
  const database = openDatabase("models/main.cdb", {
    version: "2026",
    edition: "educational",
    environmentRoot: "installed/sofistik",
    exists: () => true,
    bridgeFactory() {
      factoryCalls += 1;
      return bridge;
    },
  });
  return { bridge, database, requests, factoryCalls: () => factoryCalls };
}

const installRoot = path.join(path.resolve("installed/sofistik"), "2026", "SOFiSTiK 2026");

describe("CdbDatabase", () => {
  it("forwards an explicit envelope omission without changing decoding policy", async () => {
    const { database, requests } = fixture();
    await database.read("beamHingeReactions", 151, { includeEnvelope: false });
    expect(requests.at(-1).options.payload).toEqual({
      name: "beamHingeReactions",
      secondary: 151,
      decodePolicy: "variable-tail",
      includeEnvelope: false,
    });
    await expectAsync(
      database.read("beamHingeReactions", 151, { includeEnvelope: "false" }),
    ).toBeRejectedWithError(TypeError);
    await database.dispose();
  });
  it("opens on the first read and hands the worker the resolved interface", async () => {
    const { database, requests, factoryCalls } = fixture();
    expect(factoryCalls()).toBe(0);

    expect(await database.read("nodes")).toEqual({ name: "nodes", count: 2, columns: {} });
    expect(Array.from(await database.keys("loadCase"))).toEqual([101, 102]);
    expect(await database.read("nodeResults", 101, { decodePolicy: "variable-tail" })).toEqual(
      jasmine.objectContaining({ name: "nodeResults" }),
    );

    expect(factoryCalls()).toBe(1);
    expect(requests.map(({ operation }) => operation)).toEqual([
      "open",
      "records",
      "keys",
      "records",
    ]);
    expect(requests[0].options.payload).toEqual({
      databasePath: path.resolve("models/main.cdb"),
      dllPath: path.join(installRoot, "interfaces", "64bit", "sof_cdb_w_edu-2026.dll"),
      // The worker is handed the whole environment, not only this release: a
      // record stored in a form this release does not describe is looked up in
      // the releases installed beside it.
      environmentRoot: path.resolve("installed/sofistik"),
      version: "2026",
      installRoot,
    });
    // A read names the record, the key it is stored under, and whether the
    // caller accepts the fields an older database does store.
    expect(requests.at(-1).options.payload).toEqual({
      name: "nodeResults",
      secondary: 101,
      decodePolicy: "variable-tail",
    });
  });

  it("owns one worker bridge per database and disposes it once", async () => {
    const first = fixture();
    const second = fixture();

    await Promise.all([first.database.read("nodes"), second.database.read("nodes")]);
    expect(first.factoryCalls()).toBe(1);
    expect(second.factoryCalls()).toBe(1);
    expect(first.bridge).not.toBe(second.bridge);

    await first.database.dispose();
    await first.database.dispose();
    expect(first.requests.at(-1)).toEqual({
      operation: "close",
      options: { readerId: 17, timeoutMs: 2000 },
    });
    expect(first.bridge.disposed).toBe(true);
    // read is async, so a closed database rejects rather than throwing.
    await expectAsync(first.database.read("nodes")).toBeRejectedWithError(/closed/i);
  });

  it("validates the runtime selection at the public boundary", () => {
    expect(() => new CdbDatabase("model.inp", {})).toThrowError(/\.cdb path/i);
    expect(() => new CdbDatabase("model.cdb", {})).toThrowError(/version/);
    expect(
      () => new CdbDatabase("model.cdb", { version: "2026", exists: () => false }),
    ).toThrowError(/not installed/);
  });
});

describe("database shutdown boundaries", () => {
  it("finishes shutdown when opening never responds", async () => {
    let rejectOpen;
    const bridge = {
      request: () =>
        new Promise((_, reject) => {
          rejectOpen = reject;
        }),
      dispose: jasmine.createSpy("dispose").and.callFake(() => rejectOpen(new Error("Stopped"))),
    };
    const db = openDatabase("model.cdb", {
      version: "2026",
      exists: () => true,
      bridgeFactory: () => bridge,
      shutdownTimeoutMs: 10,
    });
    const read = db.read("nodes");
    const rejection = expectAsync(read).toBeRejected();
    await db.dispose();
    await rejection;
    expect(bridge.dispose).toHaveBeenCalledTimes(1);
  });
  it("does not issue a record query after disposal starts during opening", async () => {
    let resolveOpen;
    const operations = [];
    const bridge = {
      request(operation) {
        operations.push(operation);
        return operation === "open"
          ? new Promise((resolve) => {
              resolveOpen = resolve;
            })
          : Promise.resolve();
      },
      dispose() {},
    };
    const db = openDatabase("model.cdb", {
      version: "2026",
      exists: () => true,
      bridgeFactory: () => bridge,
    });
    const read = db.read("nodes");
    const dispose = db.dispose();
    resolveOpen(1);
    await expectAsync(read).toBeRejectedWithError(/closed/);
    await dispose;
    expect(operations).toEqual(["open", "close"]);
  });
  it("rejects an unknown decoding policy before opening native state", async () => {
    const { database, factoryCalls } = fixture();
    await expectAsync(
      database.read("nodes", undefined, { decodePolicy: "guess" }),
    ).toBeRejectedWithError(/policy/);
    expect(factoryCalls()).toBe(0);
    await database.dispose();
  });
});
