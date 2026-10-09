const { CdbRecordReader } = require("../lib/record-reader");

// The fields shared by BEAM_FOR/FTR and FOC/FTC in the SOFiSTiK CDB headers.
// The help makes UX..MT3 conditional on results calculated with STAR2 or ASE;
// a force-only record ends immediately after MT2.
const FORCE_FIELDS = ["x", "n", "vy", "vz", "mt", "my", "mz", "mb", "mt2"];
const DEFORMATION_FIELDS = ["ux", "uy", "uz", "phix", "phiy", "phiz", "phiw", "mt3"];
const BEDDING_FIELDS = ["pa", "pt", "pty", "ptz"];
const EAS_FIELDS = [
  "alph_x",
  "beta_x",
  "beta_y",
  "beta_z",
  "beta_w",
  "alph2_x",
  "beta2_x",
  "beta2_y",
  "beta2_z",
  "beta2_w",
];

function form(name, envelope) {
  const names = [
    envelope ? "id" : "nr",
    ...FORCE_FIELDS,
    ...DEFORMATION_FIELDS,
    ...BEDDING_FIELDS,
    ...(envelope ? [] : EAS_FIELDS),
  ];
  return {
    name,
    size: names.length * 4,
    fields: names.map((name, index) => ({
      name,
      offset: index * 4,
      kind: index === 0 ? "i32" : "f32",
      size: 4,
      count: 1,
      ...(name === "x" ? { unit: 1001 } : {}),
      ...(name === "ux" ? { unit: 1003 } : {}),
    })),
  };
}

function readerOf(name, records) {
  const withoutPlate = name === "beamForcesWithoutPlate";
  const forms = [
    form(withoutPlate ? "CDB_BEAM_FTC" : "CDB_BEAM_FOC", true),
    form(withoutPlate ? "CDB_BEAM_FTR" : "CDB_BEAM_FOR", false),
  ];
  const data = Buffer.alloc(records.reduce((total, record) => total + record.length, 0));
  let offset = 0;
  for (const { length, number, x, n, ux = 0 } of records) {
    data.writeInt32LE(number, offset);
    data.writeFloatLE(x, offset + 4);
    data.writeFloatLE(n, offset + 8);
    if (length >= 44) data.writeFloatLE(ux, offset + 40);
    offset += length;
  }
  const layouts = {
    has: (name) => forms.some((form) => form.name === name),
    layout: (name) => forms.find((form) => form.name === name),
    key: () => ({ primary: withoutPlate ? 112 : 102, variants: forms.map(({ name }) => name) }),
  };
  return new CdbRecordReader(
    {
      read: () => ({ data, lengths: Int32Array.from(records.map(({ length }) => length)) }),
    },
    { layouts, siblings: [], version: "2026" },
  );
}

describe("beam force forms", () => {
  for (const name of ["beamForces", "beamForcesWithoutPlate"]) {
    it(`reads force-only envelopes and stations for ${name}`, () => {
      const reader = readerOf(name, [
        { length: 40, number: 0, x: 2, n: 8.5 },
        { length: 40, number: 0, x: 0, n: -15.5 },
        { length: 40, number: 110001, x: 0, n: -5 },
        { length: 40, number: 0, x: 2, n: -5 },
      ]);
      const read = reader.read({ name, secondary: 302 });
      expect(read.count).toBe(2);
      expect(Array.from(read.columns.element)).toEqual([110001, 110001]);
      expect(Array.from(read.columns.n)).toEqual([-5, -5]);
      expect(read.columns.ux).toBeUndefined();
      expect(read.envelope.max.n).toBe(8.5);
      expect(read.envelope.min.n).toBe(-15.5);
      expect(read.envelope.max.ux).toBeUndefined();
      expect(read.provenance[0].mode).toBe("variable-tail");
      expect(read.partial.dropped).toEqual([
        ...DEFORMATION_FIELDS,
        ...BEDDING_FIELDS,
        ...EAS_FIELDS,
      ]);
      expect(read.partial.assumed).toBeUndefined();
      expect(read.fields.find(({ name }) => name === "x").unit).toBe(1001);
    });
  }

  it("preserves missing-deformation provenance across force-only and complete records", () => {
    const reader = readerOf("beamForces", [
      { length: 40, number: 110001, x: 0, n: -5 },
      { length: 128, number: 110002, x: 1, n: -6, ux: 2.5 },
      { length: 72, number: 0, x: 2, n: -6, ux: 3.5 },
    ]);
    const read = reader.read({ name: "beamForces", secondary: 302 });
    expect(Array.from(read.columns.element)).toEqual([110001, 110002, 110002]);
    expect(Array.from(read.recordLengths)).toEqual([40, 128, 72]);
    expect(Array.from(read.columns.ux)).toEqual([0, 2.5, 3.5]);
    expect(read.provenance.find(({ length }) => length === 40).partial.dropped).toContain("ux");
    expect(read.fields.find(({ name }) => name === "ux").unit).toBe(1003);
  });

  for (const length of [36, 44, 68]) {
    it(`refuses the undocumented ${length}-byte form`, () => {
      const reader = readerOf("beamForces", [{ length, number: 110001, x: 0, n: -5 }]);
      expect(() => reader.read({ name: "beamForces", secondary: 302 })).toThrowError(
        new RegExp(`${length} bytes`),
      );
    });
  }

  it("keeps force-only records subject to the explicitly selected exact policy", () => {
    const reader = readerOf("beamForces", [{ length: 40, number: 110001, x: 0, n: -5 }]);
    expect(() =>
      reader.read({ name: "beamForces", secondary: 302, decodePolicy: "exact" }),
    ).toThrowError(/40 bytes/);
  });
});
