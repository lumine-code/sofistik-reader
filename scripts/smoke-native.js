const assert = require("node:assert/strict");
const { loadNativeAddon } = require("../lib/native-addon");
const { openDatabase } = require("../lib");

async function main() {
  assert.equal(typeof loadNativeAddon().CdbReader, "function");
  const [file, version = "2026", edition = "professional"] = process.argv.slice(2);
  if (!file) {
    console.log("Built Node-API addon exports CdbReader.");
    return;
  }
  const database = openDatabase(file, { version, edition });
  try {
    for (const name of ["system", "nodes", "beams", "quads", "springs", "couplings", "groups"]) {
      const read = await database.read(name);
      assert.equal(read.count, read.columns[read.fields[0]?.name]?.length ?? 0);
      assert.equal(
        read.provenance.reduce((sum, form) => sum + form.count, 0),
        read.count,
      );
      console.log(`${name}: ${read.count} records`);
    }
    const cases = await database.keys("nodeResults");
    if (cases.length) {
      for (const name of ["nodeResults", "beamForces"]) {
        const read = await database.read(name, cases[0]);
        console.log(`${name}/${cases[0]}: ${read.count} records`);
      }
    }
  } finally {
    await database.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
