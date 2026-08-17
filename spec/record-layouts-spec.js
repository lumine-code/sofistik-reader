const {
  RecordLayouts,
  clearRecordLayoutCache,
  recordLayoutsFor,
} = require("../lib/record-layouts");

// A stand-in for one installation's headers, in the exact shape SOFiSTiK
// generates: a tagged struct per record, a union naming the record kinds that
// share a key, and the key as macros.
const HEADERS = {
  "cdbtypetest.h": `
/*   SOFiSTiK AG - automatically generated header, do not modify */

typedef struct tagCDB_SAMPLE {    /* 42/00  A sample record */
int     m_nr;                     /*        number */
float   m_xyz[3];                 /* [1001] ordinates */
double  m_time;                   /*        needs eight-byte alignment */
int     m_flags[2][2];            /*        a two-dimensional array */
} typeCDB_SAMPLE;

typedef struct tagCDB_SAMPLE_MAX { /* 42/00  The envelope of the sample */
int     m_nr;
float   m_xyz[3];
} typeCDB_SAMPLE_MAX;

typedef struct tagCDB_INNER {
int     m_a;
float   m_b[2];
} typeCDB_INNER;

typedef struct tagCDB_OUTER {
int           m_head;
typeCDB_INNER m_parts[2];
} typeCDB_OUTER;

typedef struct tagCDB_LABEL {
int      m_nr;
pckcode  m_text[3];
} typeCDB_LABEL;

#define SAMPLE_KWH 42
#define SAMPLE_KWL 0
#define SAMPLE_VER 202601
typedef union taguSAMPLE {   /* 42/00 */
int m_id;
typeCDB_SAMPLE_MAX m_sample_max;
typeCDB_SAMPLE m_sample;
} typeuSAMPLE;

#define RESULT_KWH 102
typedef union taguRESULT {   /* 102/LC */
int m_id;
typeCDB_SAMPLE m_sample;
} typeuRESULT;
`,
  "notes.txt": "ignored, not a record header",
};

function layouts() {
  clearRecordLayoutCache();
  return recordLayoutsFor("C:/installed/SOFiSTiK 2026", {
    headerDirectory: "headers",
    readdir: () => Object.keys(HEADERS),
    readFile: (file) => HEADERS[file.split(/[\\/]/).pop()],
  });
}

describe("recordLayoutsFor", () => {
  it("computes field offsets with the alignment the compiler used", () => {
    const sample = layouts().layout("CDB_SAMPLE");
    expect(sample.fields).toEqual([
      { name: "nr", kind: "i32", offset: 0, size: 4, count: 1, dimensions: [] },
      { name: "xyz", kind: "f32", offset: 4, size: 4, count: 3, dimensions: [3] },
      // Padded from 16 to 16: already aligned, but the double sets the record's
      // own alignment, which rounds the size up.
      { name: "time", kind: "f64", offset: 16, size: 8, count: 1, dimensions: [] },
      { name: "flags", kind: "i32", offset: 24, size: 4, count: 4, dimensions: [2, 2] },
    ]);
    expect(sample.size).toBe(40);
    expect(sample.alignment).toBe(8);
  });

  it("flattens a nested record into the record that contains it", () => {
    const outer = layouts().layout("CDB_OUTER");
    expect(outer.fields.map(({ name, offset }) => `${name}@${offset}`)).toEqual([
      "head@0",
      "parts0_a@4",
      "parts0_b@8",
      "parts1_a@16",
      "parts1_b@20",
    ]);
    expect(outer.size).toBe(28);
  });

  it("reads the key and its record kinds from the union that shares them", () => {
    const table = layouts();
    expect(table.key("SAMPLE")).toEqual({
      name: "SAMPLE",
      primary: 42,
      secondary: 0,
      // The int discriminator is not a record; the two record kinds are.
      variants: ["CDB_SAMPLE_MAX", "CDB_SAMPLE"],
    });
    // A results key has no fixed secondary: it is the load case.
    expect(table.key("RESULT").secondary).toBeNull();
  });

  it("takes a stated key for a record SOFiSTiK groups under no union", () => {
    // The headers carry a struct for every record but a union only for those
    // the interface groups, so a record with no union has no key to look up and
    // states one instead. Its own kind is then the only one stored under it.
    const table = layouts();
    expect(table.key({ primary: 21, secondary: 0, variants: ["CDB_SAMPLE"] })).toEqual({
      name: "CDB_SAMPLE",
      primary: 21,
      secondary: 0,
      variants: ["CDB_SAMPLE"],
    });
    // No secondary stated is a key that carries one, the way a load case does.
    expect(table.key({ primary: 21, variants: ["CDB_SAMPLE"] }).secondary).toBeNull();
    // A key that states nothing to find is not a key.
    expect(() => table.key({ variants: ["CDB_SAMPLE"] })).toThrowError(/primary number/);
    expect(() => table.key({ primary: 21, variants: [] })).toThrowError(/primary number/);
  });

  it("keeps packed text as codes, since only the interface can unpack them", () => {
    const label = layouts().layout("CDB_LABEL");
    expect(label.fields[1]).toEqual({
      name: "text",
      kind: "text",
      offset: 4,
      size: 4,
      count: 3,
      dimensions: [3],
    });
  });

  it("reads one installation once and refuses what it cannot answer", () => {
    let reads = 0;
    const options = {
      headerDirectory: "counted",
      readdir: () => {
        reads += 1;
        return Object.keys(HEADERS);
      },
      readFile: (file) => HEADERS[file.split(/[\\/]/).pop()],
    };
    clearRecordLayoutCache();
    const first = recordLayoutsFor("C:/installed", options);
    const second = recordLayoutsFor("C:/installed", options);
    expect(second).toBe(first);
    expect(reads).toBe(1);

    expect(() => first.layout("CDB_ABSENT")).toThrowError(/CDB_ABSENT is not defined/);
    expect(() => first.key("ABSENT")).toThrowError(/ABSENT is not defined/);
    expect(first.has("CDB_SAMPLE")).toBe(true);
    expect(
      () =>
        new RecordLayouts("empty", { structures: new Map(), unions: new Map(), macros: new Map() }),
    ).not.toThrow();
    clearRecordLayoutCache();
    expect(() =>
      recordLayoutsFor("C:/installed", { ...options, headerDirectory: "bare", readdir: () => [] }),
    ).toThrowError(/No SOFiSTiK CDB record headers/);
  });
});
