const { CdbRecordReader } = require("../lib/record-reader");
const { GROUP_FLAGS } = require("../lib");

function groupFixtures(rows) {
  const integerNames = ["ng", "typ", "num", "min", "max", "mnr", "mbw", "inf"];
  const floatNames = [
    "faks",
    "v2",
    "v3",
    "v4",
    "v5",
    "v6",
    "etot",
    "ecom",
    "edev",
    "ekin",
    "epot",
    "edam",
    "h_gw",
    "v14",
  ];
  const form = {
    name: "CDB_GRP_LC",
    size: 156,
    fields: [
      ...integerNames.map((name, index) => ({
        name,
        offset: index * 4,
        kind: "i32",
        count: 1,
        size: 4,
      })),
      ...floatNames.map((name, index) => ({
        name,
        offset: 32 + index * 4,
        kind: "f32",
        count: 1,
        size: 4,
      })),
      { name: "text", offset: 88, kind: "text", count: 17, size: 4 },
    ],
  };
  const lengths = rows.map(({ typ }) => (typ === 0 ? 156 : 32));
  const data = Buffer.alloc(lengths.reduce((total, length) => total + length, 0));
  let offset = 0;
  rows.forEach((row, index) => {
    integerNames.forEach((name, field) => data.writeInt32LE(row[name] || 0, offset + field * 4));
    if (row.typ === 0) data.writeFloatLE(row.faks ?? 1, offset + 32);
    offset += lengths[index];
  });
  const layouts = {
    layout: () => form,
    has: (name) => name === form.name,
    id: () => null,
    key: (name) => ({ name, primary: 11, secondary: null, variants: [form.name] }),
  };
  const native = {
    read: jasmine.createSpy("read").and.returnValue({
      data,
      lengths: Int32Array.from(lengths),
    }),
  };
  return {
    reader: new CdbRecordReader(native, { layouts, siblings: [], version: "2026" }),
    native,
  };
}

describe("load-case specific groups", () => {
  it("reads the full group and short element-type states in original order", () => {
    const { reader, native } = groupFixtures([
      { ng: 11, typ: 0, inf: 11271 },
      { ng: 11, typ: 100, inf: 11271 },
      { ng: 51, typ: 0, inf: 10237953 },
      { ng: 51, typ: 200, inf: 10237953 },
    ]);
    const read = reader.read({ name: "loadCaseGroups", secondary: 4011 });
    expect(native.read).toHaveBeenCalledWith(11, 4011, 156);
    expect(read.count).toBe(4);
    expect(Array.from(read.recordLengths)).toEqual([156, 32, 156, 32]);
    expect(Array.from(read.columns.ng)).toEqual([11, 11, 51, 51]);
    expect(Array.from(read.columns.typ)).toEqual([0, 100, 0, 200]);
    expect(Array.from(read.columns.inf)).toEqual([11271, 11271, 10237953, 10237953]);
    expect(Array.from(read.columns.inf, (info) => (info & GROUP_FLAGS.active) !== 0)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    // The excluded group still has FAKS=1; stiffness is not an activation flag.
    expect(Array.from(read.columns.faks)).toEqual([1, 0, 1, 0]);
    expect(read.skipped).toEqual([]);
    expect(read.provenance.map(({ length, count, mode }) => ({ length, count, mode }))).toEqual([
      { length: 156, count: 2, mode: "exact" },
      { length: 32, count: 2, mode: "variable-tail" },
    ]);
  });

  it("reports missing case-specific group information as an empty read", () => {
    const { reader } = groupFixtures([]);
    const read = reader.read({ name: "loadCaseGroups", secondary: 302 });
    expect(read.count).toBe(0);
    expect(read.columns.ng.length).toBe(0);
  });

  it("requires a load-case number rather than falling back to global group data", () => {
    const { reader, native } = groupFixtures([]);
    expect(() => reader.read({ name: "loadCaseGroups" })).toThrowError(/loadCase number/);
    expect(native.read).not.toHaveBeenCalled();
  });
});
