const { CdbRecordReader } = require("../lib/record-reader");

// The installed 2026 layout shares its final stress-location fields with SPT,
// but AQUA stores polygon geometry only through RT2 (76 bytes).
function polygonFixtures(lengths = [76, 108, 76], version = "2026") {
  const names = [
    "id",
    "mno",
    "idp",
    "tnr",
    "y",
    "z",
    "rt",
    "wty",
    "wvyy",
    "wvzy",
    "wt2y",
    "wtz",
    "wvyz",
    "wvzz",
    "wt2z",
    "w0",
    "epsr",
    "exp",
    "rt2",
    "fix",
    "sigd",
    "taud",
    "litd",
    "sigy",
    "aref",
    "temp",
    "temp1",
  ];
  if (version === "2018") names.splice(names.indexOf("rt2"), 1);
  const forms = {
    CDB_SECT: {
      name: "CDB_SECT",
      size: 8,
      fields: ["id", "mno"].map((name, index) => ({
        name,
        offset: index * 4,
        kind: "i32",
        size: 4,
        count: 1,
      })),
    },
    CDB_SECT_PPT: {
      name: "CDB_SECT_PPT",
      size: names.length * 4,
      fields: names.map((name, index) => ({
        name,
        offset: index * 4,
        kind: index < 4 ? "i32" : "f32",
        size: 4,
        count: 1,
      })),
    },
  };
  const data = Buffer.alloc(8 + lengths.reduce((total, length) => total + length, 0));
  data.writeInt32LE(1, 4);
  let offset = 8;
  lengths.forEach((length, index) => {
    data.writeInt32LE(101, offset);
    data.writeInt32LE(1, offset + 4);
    data.writeInt32LE(index === 2 ? 100 * 256 + 65 : 2 * 256, offset + 8);
    data.writeFloatLE(index / 10, offset + 16);
    data.writeFloatLE((index + 1) / 10, offset + 20);
    data.writeFloatLE(index === 2 ? -0.008 : 0.012, offset + 24);
    const rt2Offset = names.indexOf("rt2") * 4;
    const fixOffset = names.indexOf("fix") * 4;
    if (rt2Offset >= 0 && length >= rt2Offset + 4) {
      data.writeFloatLE(-99999, offset + rt2Offset);
    }
    if (length >= fixOffset + 4) data.writeFloatLE(0.02, offset + fixOffset);
    offset += length;
  });
  const layouts = {
    layout: (name) => forms[name],
    has: (name) => Boolean(forms[name]),
    id: (name) => (name === "CDB_SECT_PPT" ? 101 : null),
    key: () => ({ name: "SECT", primary: 9, secondary: null, variants: Object.keys(forms) }),
  };
  return new CdbRecordReader(
    {
      read: () => ({ data, lengths: Int32Array.from([8, ...lengths]) }),
    },
    { layouts, siblings: [], version },
  );
}

describe("section polygon geometry records", () => {
  it("keeps short vertices and generated holes alongside full stress records", () => {
    const read = polygonFixtures().read({ name: "section", secondary: 11 });
    expect(read.polygon.count).toBe(3);
    expect(Array.from(read.polygon.recordLengths)).toEqual([76, 108, 76]);
    expect(Array.from(read.polygon.columns.idp)).toEqual([512, 512, 25665]);
    expect(Array.from(read.polygon.columns.rt2)).toEqual([-99999, -99999, -99999]);
    expect(Array.from(read.polygon.columns.fix)).toEqual([0, Math.fround(0.02), 0]);
    expect(read.polygon.columns.y[2]).toBeCloseTo(0.2, 6);
    expect(read.polygon.columns.z[2]).toBeCloseTo(0.3, 6);
    expect(read.polygon.columns.rt[2]).toBeCloseTo(-0.008, 6);
    expect(read.polygon.skipped).toEqual([]);
    expect(
      read.polygon.provenance.map(({ length, count, mode }) => ({ length, count, mode })),
    ).toEqual([
      { length: 76, count: 2, mode: "variable-tail" },
      { length: 108, count: 1, mode: "exact" },
    ]);
  });

  it("does not assume a polygon missing RT2 is the documented geometry form", () => {
    const read = polygonFixtures([72]).read({ name: "section", secondary: 11 });
    expect(read.polygon.count).toBe(0);
    expect(read.polygon.skipped).toEqual([{ length: 72, count: 1 }]);
  });

  it("uses the older geometry boundary when the selected layout has no RT2", () => {
    const read = polygonFixtures([72, 104, 72], "2018").read({
      name: "section",
      secondary: 11,
    });
    expect(read.polygon.count).toBe(3);
    expect(Array.from(read.polygon.recordLengths)).toEqual([72, 104, 72]);
    expect(Array.from(read.polygon.columns.idp)).toEqual([512, 512, 25665]);
    expect(read.polygon.columns.rt2).toBeUndefined();
    expect(Array.from(read.polygon.columns.fix)).toEqual([0, Math.fround(0.02), 0]);
    expect(read.polygon.columns.rt[2]).toBeCloseTo(-0.008, 6);
    expect(read.polygon.skipped).toEqual([]);
    expect(
      read.polygon.provenance.map(({ length, mode, version }) => ({ length, mode, version })),
    ).toEqual([
      { length: 72, mode: "variable-tail", version: "2018" },
      { length: 104, mode: "exact", version: "2018" },
    ]);
  });

  it("does not accept arbitrary partial stress-location tails", () => {
    const read = polygonFixtures([80]).read({ name: "section", secondary: 11 });
    expect(read.polygon.count).toBe(0);
    expect(read.polygon.skipped).toEqual([{ length: 80, count: 1 }]);
  });

  it("continues to require full described records under the exact policy", () => {
    expect(() =>
      polygonFixtures([76]).read({
        name: "section",
        secondary: 11,
        decodePolicy: "exact",
      }),
    ).toThrowError(/CDB_SECT_PPT at 76 bytes/);
  });
});
