const { CdbRecordReader } = require("../lib/record-reader");

// Field order and quantity codes follow DATEN 103, 105 and 111. These small
// independent layouts exercise native bytes through the complete reader on
// platforms where the proprietary SOFiSTiK headers are not installed.
function form(name, fields) {
  let size = 0;
  return {
    name,
    fields: fields.map(([field, kind = "f32", count = 1, unit]) => {
      const result = { name: field, kind, count, offset: size, size: 4, ...(unit ? { unit } : {}) };
      size += count * 4;
      return result;
    }),
    get size() {
      return size;
    },
  };
}

const STRESS_CORE = [
  ["nr", "i32"],
  ["mnr", "i32"],
  ["x", "f32", 1, 1001],
  ...["sigc", "sigt", "tau", "sigv", "si", "sii"].map((name) => [name, "f32", 1, 1092]),
];
const STRESS_TAIL = [
  ...["sigo", "sigu", "dsig", "dtau", "sigw"].map((name) => [name, "f32", 1, 1092]),
  ["vb", "f32", 1, 1153],
  ["fak_vv"],
  ["n_part", "f32", 1, 1101],
  ["sigct", "f32", 1, 1092],
];
const STRESS = form("CDB_BEAM_STR", [...STRESS_CORE, ...STRESS_TAIL]);
const STRESS_ENVELOPE = form("CDB_BEAM_STC", [...STRESS_CORE, ...STRESS_TAIL]);
const TENDON = form("CDB_BEAM_STT", [["nr", "i32"], ["nrs", "i32"], ["x"], ["sig"], ["dsig"]]);
const THERMAL = form("CDB_BEAM_TST", [["nr", "i32"], ["mnrx", "i32"], ["x"], ["ts", "f32", 256]]);
const STIFFNESS = form("CDB_BEAM_STI", [
  ["nr", "i32"],
  ["x", "f32", 1, 1001],
  ...["ea", "gay", "gaz"].map((name) => [name, "f32", 1, 62]),
  ...["git", "eiy", "eiz", "eiyz"].map((name) => [name, "f32", 1, 83]),
  ["gayz", "f32", 1, 62],
  ["kpx", "f32", 1, 8],
  ["kpy", "f32", 1, 17],
  ["kpz", "f32", 1, 17],
]);
const HINGE = form("CDB_BEAM_HRC", [
  ["nr", "i32"],
  ["typ", "i32"],
  ["mtyp", "i32"],
  ["ibit", "i32"],
  ["x", "f32", 1, 1001],
  ["reac"],
  ["stv", "f32", 11],
  ["pidx", "f32", 6],
]);
const HINGE_ENVELOPE = form("CDB_BEAM_HR0", [
  ["id", "i32"],
  ["ibit", "i32", 3],
  ["x", "f32", 1, 1001],
  ["reac"],
  ["stv", "f32", 10],
  ["pidx", "f32", 6],
]);

function readerOf(primary, forms, rows) {
  const lengths = rows.map(({ layout, length }) => length ?? layout.size);
  const data = Buffer.alloc(lengths.reduce((sum, length) => sum + length, 0));
  let offset = 0;
  rows.forEach(({ layout, values }, row) => {
    for (const field of layout.fields) {
      const value = values[field.name];
      if (value == null) continue;
      const valuesAtField = Array.isArray(value) ? value : [value];
      valuesAtField.forEach((value, index) => {
        const at = field.offset + index * 4;
        if (at + 4 > lengths[row]) return;
        data[field.kind === "i32" ? "writeInt32LE" : "writeFloatLE"](value, offset + at);
      });
    }
    offset += lengths[row];
  });
  const native = {
    read: jasmine.createSpy("read").and.returnValue({ data, lengths: Int32Array.from(lengths) }),
  };
  const layouts = {
    has: (name) => forms.some((layout) => layout.name === name),
    layout: (name) => forms.find((layout) => layout.name === name),
    id: () => null,
    key: () => ({ primary, variants: forms.map(({ name }) => name) }),
  };
  return {
    native,
    reader: new CdbRecordReader(native, { layouts, siblings: [], version: "2026" }),
  };
}

describe("documented beam result records", () => {
  it("omits all leading stress summaries while preserving subsequent zero-numbered continuations", () => {
    const { reader } = readerOf(
      105,
      [STRESS, STRESS_ENVELOPE],
      [
        ...[1025, 1026, 1027].map((mnr) => ({
          layout: STRESS_ENVELOPE,
          length: 36,
          values: { nr: 0, mnr, sigc: -99 },
        })),
        { layout: STRESS, length: 36, values: { nr: 10, mnr: 1025, x: 0, sigc: -20 } },
        { layout: STRESS, length: 36, values: { nr: 0, mnr: 1025, x: 4, sigc: -10 } },
      ],
    );
    const read = reader.read({ name: "beamStresses", secondary: 1, includeEnvelope: false });
    expect(read.count).toBe(2);
    expect(Array.from(read.columns.element)).toEqual([10, 10]);
    expect(Array.from(read.columns.sigc)).toEqual([-20, -10]);
    expect(read.envelope).toBeNull();
    expect(read.omittedEnvelope).toEqual({ count: 3, lengths: [36, 36, 36] });
  });

  it("skips requested hinge summaries of unknown size while strictly decoding the real reactions", () => {
    const records = [
      { layout: HINGE_ENVELOPE, length: 92, values: { id: 0, reac: 88 } },
      { layout: HINGE, values: { nr: 10, typ: 15, x: 2, reac: -8 } },
    ];
    const { reader } = readerOf(111, [HINGE, HINGE_ENVELOPE], records);
    expect(() => reader.read({ name: "beamHingeReactions", secondary: 1 })).toThrowError(
      /92 bytes/,
    );
    const read = reader.read({
      name: "beamHingeReactions",
      secondary: 1,
      includeEnvelope: false,
      decodePolicy: "exact",
    });
    expect(read.count).toBe(1);
    expect(Array.from(read.columns.reac)).toEqual([-8]);
    expect(read.omittedEnvelope).toEqual({ count: 1, lengths: [92] });
    expect(read.envelope).toBeNull();
    records[1].length = 32;
    const corrupt = readerOf(111, [HINGE, HINGE_ENVELOPE], records);
    expect(() =>
      corrupt.reader.read({ name: "beamHingeReactions", secondary: 1, includeEnvelope: false }),
    ).toThrowError(/32 bytes/);
  });
  it("reads short stress envelopes and stations without claiming absent optional stresses", () => {
    const { reader } = readerOf(
      105,
      [STRESS, STRESS_ENVELOPE],
      [
        {
          layout: STRESS_ENVELOPE,
          length: 36,
          values: { nr: 0, mnr: 1025, x: 8, sigc: -30, sigt: 20 },
        },
        {
          layout: STRESS_ENVELOPE,
          length: 36,
          values: { nr: 0, mnr: 1025, x: 0, sigc: -45, sigt: 12 },
        },
        { layout: STRESS, length: 36, values: { nr: -10, mnr: 1025, x: 4, sigc: -35, sigt: 15 } },
        {
          layout: STRESS,
          length: 44,
          values: { nr: 10, mnr: 1025, x: 4, sigc: -25, sigo: -20, sigu: 18 },
        },
      ],
    );
    const read = reader.read({ name: "beamStresses", secondary: 1 });
    expect(read.count).toBe(2);
    expect(Array.from(read.columns.element)).toEqual([10, 10]);
    expect(Array.from(read.columns.sigc)).toEqual([-35, -25]);
    expect(Array.from(read.recordLengths)).toEqual([36, 44]);
    expect(read.columns.vb).toBeUndefined();
    expect(read.envelope.max.sigc).toBe(-30);
    expect(read.envelope.min.sigc).toBe(-45);
    expect(read.envelope.max.sigo).toBeUndefined();
    expect(read.provenance.find(({ length }) => length === 36).partial.dropped).toContain("sigo");
    expect(read.provenance.every(({ mode }) => mode === "variable-tail")).toBe(true);
    expect(read.fields.find(({ name }) => name === "sigc").unit).toBe(1092);
  });

  it("keeps packed stress points separate from the six-digit thermal discriminator", () => {
    const packedPoint = Buffer.from("TOP1").readInt32LE(0);
    const { reader } = readerOf(
      105,
      [STRESS, STRESS_ENVELOPE, TENDON, THERMAL],
      [
        { layout: STRESS, length: 36, values: { nr: 7, mnr: packedPoint, x: 0, sigc: -12 } },
        { layout: THERMAL, length: 20, values: { nr: 7, mnrx: 100001, x: 0, ts: [1, 2] } },
        { layout: TENDON, values: { nr: 7, nrs: -11, x: 0, sig: 99 } },
      ],
    );
    const read = reader.read({ name: "beamStresses", secondary: 1 });
    expect(read.count).toBe(1);
    expect(read.columns.materialName).toEqual(["TOP1"]);
    expect(read.thermal.count).toBe(1);
    expect(Array.from(read.thermal.columns.ts)).toEqual([1, 2]);
    expect(read.tendons.count).toBe(1);
    expect(Array.from(read.tendons.columns.sig)).toEqual([99]);
  });

  it("rejects incomplete stress cores and honors exact decoding", () => {
    const { reader } = readerOf(
      105,
      [STRESS, STRESS_ENVELOPE],
      [{ layout: STRESS, length: 32, values: { nr: 10, mnr: 1025 } }],
    );
    expect(() => reader.read({ name: "beamStresses", secondary: 1 })).toThrowError(/32 bytes/);
    const short = readerOf(
      105,
      [STRESS, STRESS_ENVELOPE],
      [{ layout: STRESS, length: 36, values: { nr: 10, mnr: 1025 } }],
    );
    expect(() =>
      short.reader.read({ name: "beamStresses", secondary: 1, decodePolicy: "exact" }),
    ).toThrowError(/36 bytes/);
  });

  it("dispatches stiffness records to key 103 with station continuation and quantity metadata", () => {
    const { reader, native } = readerOf(
      103,
      [STIFFNESS],
      [
        { layout: STIFFNESS, values: { nr: 21, x: 0, ea: 2500, eiy: 750, kpy: 0.5 } },
        { layout: STIFFNESS, values: { nr: 0, x: 8, ea: 2400, eiy: 700, kpy: 0.75 } },
      ],
    );
    const read = reader.read({ name: "beamStiffness", secondary: 501 });
    expect(native.read).toHaveBeenCalledWith(103, 501, STIFFNESS.size);
    expect(Array.from(read.columns.element)).toEqual([21, 21]);
    expect(Array.from(read.columns.eiy)).toEqual([750, 700]);
    expect(read.fields.find(({ name }) => name === "kpy").unit).toBe(17);
    expect(read.envelope).toBeNull();
  });

  it("reads typed hinge reactions and state-variable arrays from key 111", () => {
    const { reader, native } = readerOf(
      111,
      [HINGE, HINGE_ENVELOPE],
      [
        { layout: HINGE_ENVELOPE, values: { id: 0, x: 8, reac: 25 } },
        { layout: HINGE_ENVELOPE, values: { id: 0, x: 0, reac: -40 } },
        {
          layout: HINGE,
          values: {
            nr: 21,
            typ: 15,
            mtyp: 1,
            x: 0,
            reac: -12,
            stv: [0.25, 0.5, 0.75],
            pidx: [1, 2, 3, 4, 5, 6],
          },
        },
      ],
    );
    const read = reader.read({ name: "beamHingeReactions", secondary: 501 });
    expect(native.read).toHaveBeenCalledWith(111, 501, HINGE.size);
    expect(read.count).toBe(1);
    expect(Array.from(read.columns.typ)).toEqual([15]);
    expect(Array.from(read.columns.reac)).toEqual([-12]);
    expect(Array.from(read.columns.stv).slice(0, 3)).toEqual([0.25, 0.5, 0.75]);
    expect(read.fields.find(({ name }) => name === "stv").count).toBe(11);
    expect(read.fields.find(({ name }) => name === "reac").unit).toBeUndefined();
    expect(read.envelope.max.reac).toBe(25);
    expect(read.envelope.min.reac).toBe(-40);
  });
});
