const fs = require("node:fs");
const path = require("node:path");
const { CdbDatabase, resolveInterface } = require("../lib");
const { recordLayoutsFor } = require("../lib/record-layouts");
const { CdbRecordReader } = require("../lib/record-reader");

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

describe("native member result records", () => {
  it("decodes real short stress and key-112 records while omitting incompatible hinge summaries", async () => {
    const fixture = installedFixture();
    if (!fixture) return;
    const database = new CdbDatabase(fixture.databasePath, fixture.options);
    try {
      const stress = await database.read("beamStresses", 151, { includeEnvelope: false });
      expect(stress.count).toBeGreaterThan(1000);
      expect(stress.omittedEnvelope.count).toBeGreaterThan(2);
      expect(stress.columns.element[0]).toBeGreaterThan(0);
      expect(
        stress.provenance.some(({ length, mode }) => length === 36 && mode === "variable-tail"),
      ).toBe(true);
      const forces = await database.read("beamForcesWithoutPlate", 99882, {
        includeEnvelope: false,
      });
      expect(forces.count).toBe(2);
      expect(Array.from(forces.columns.element)).toEqual([720092, 720092]);
      const short = forces.provenance.find(({ length }) => length === 64);
      expect(short.mode).toBe("documented-prefix");
      expect(short.partial.dropped).toContain("ux");
      expect(short.partial.omittedBytes).toBe(24);
      const hinges = await database.read("beamHingeReactions", 151, { includeEnvelope: false });
      expect(hinges.count).toBe(0);
      expect(hinges.omittedEnvelope).toEqual({ count: 2, lengths: [92, 92] });
    } finally {
      await database.dispose();
    }
  });

  it("reads stiffness and hinge fields at the installed official header offsets", () => {
    const fixture = installedFixture();
    if (!fixture) return;
    const layouts = recordLayoutsFor(fixture.runtime.installRoot);
    for (const sample of [
      {
        name: "beamStiffness",
        record: "CDB_BEAM_STI",
        primary: 103,
        values: { nr: 17, x: 1.5, ea: 1234, eiy: 5678, ccw: 0.25 },
      },
      {
        name: "beamHingeReactions",
        record: "CDB_BEAM_HRC",
        primary: 111,
        values: { nr: 17, typ: 15, mtyp: 1, x: 1.5, reac: -12.5, stv: [0.25, 0.5, 0.75] },
      },
    ]) {
      const layout = layouts.layout(sample.record);
      const data = Buffer.alloc(layout.size);
      for (const [name, value] of Object.entries(sample.values)) {
        const field = layout.fields.find((field) => field.name === name);
        (Array.isArray(value) ? value : [value]).forEach((number, index) => {
          data[field.kind === "i32" ? "writeInt32LE" : "writeFloatLE"](
            number,
            field.offset + index * field.size,
          );
        });
      }
      const native = {
        read: jasmine
          .createSpy("read")
          .and.returnValue({ data, lengths: Int32Array.of(layout.size) }),
      };
      const reader = new CdbRecordReader(native, { layouts, siblings: [], version: "2026" });
      const read = reader.read({ name: sample.name, secondary: 1 });
      expect(native.read).toHaveBeenCalledWith(sample.primary, 1, layout.size);
      expect(read.count).toBe(1);
      for (const [name, value] of Object.entries(sample.values)) {
        const expected = Array.isArray(value) ? value : [value];
        expect(Array.from(read.columns[name]).slice(0, expected.length)).toEqual(expected);
      }
    }
  });
});
