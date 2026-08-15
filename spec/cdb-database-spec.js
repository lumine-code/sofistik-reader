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
  it("opens on the first read and hands the worker the resolved interface", async () => {
    const { database, requests, factoryCalls } = fixture();
    expect(factoryCalls()).toBe(0);

    expect(await database.read("nodes")).toEqual({ name: "nodes", count: 2, columns: {} });
    expect(Array.from(await database.keys("loadCase"))).toEqual([101, 102]);
    expect(await database.read("nodeResults", 101, { partial: true })).toEqual(
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
      installRoot,
    });
    // A read names the record, the key it is stored under, and whether the
    // caller accepts the fields an older database does store.
    expect(requests.at(-1).options.payload).toEqual({
      name: "nodeResults",
      secondary: 101,
      partial: true,
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
      options: { readerId: 17 },
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
