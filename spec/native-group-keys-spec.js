const fs = require("node:fs");
const path = require("node:path");
const { CdbDatabase, GROUP_FLAGS, resolveInterface } = require("../lib");
const { loadNativeAddon } = require("../lib/native-addon");

function installedFixture() {
  const databasePath = path.resolve(__dirname, "../../graviss-sofistik/.dev/main-5.cdb");
  if (process.platform !== "win32" || !fs.existsSync(databasePath)) {
    pending("Requires the local main-5.cdb example and a Windows SOFiSTiK installation.");
    return null;
  }
  const options = { version: "2026", edition: "educational" };
  try {
    return { databasePath, options, runtime: resolveInterface(options) };
  } catch {
    pending("Requires the educational SOFiSTiK 2026 CDB interface.");
    return null;
  }
}

describe("native group key enumeration", () => {
  it("continues past the global zero key to load-case group states", async () => {
    const fixture = installedFixture();
    if (!fixture) return;
    const { databasePath, options } = fixture;
    const database = new CdbDatabase(databasePath, options);
    try {
      const keys = Array.from(await database.keys("loadCaseGroups"));
      for (const key of [0, 302, 4011, 4012, 5011, 5012]) expect(keys).toContain(key);
      expect(keys.filter((key) => key === 0).length).toBe(1);
      const read = await database.read("loadCaseGroups", 4011);
      expect(read.count).toBeGreaterThan(0);
      const index = Array.from(read.columns.ng).findIndex(
        (group, row) => group === 51 && read.columns.typ[row] === 0,
      );
      expect(index).toBeGreaterThanOrEqual(0);
      expect(read.columns.inf[index] & GROUP_FLAGS.active).toBe(0);
    } finally {
      await database.dispose();
    }
  });

  it("returns no secondary keys for a missing primary instead of inventing key zero", () => {
    const fixture = installedFixture();
    if (!fixture) return;
    const { databasePath, runtime } = fixture;
    const previousPath = process.env.PATH;
    let reader;
    try {
      process.env.PATH = [
        path.dirname(runtime.dllPath),
        runtime.installRoot,
        previousPath || "",
      ].join(path.delimiter);
      const { CdbReader } = loadNativeAddon();
      reader = new CdbReader(databasePath, runtime.dllPath);
      expect(Array.from(reader.keys(9999))).toEqual([]);
      expect(Array.from(reader.keys(11))).toContain(0);
    } finally {
      reader?.close();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
