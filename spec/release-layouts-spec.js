const {
  layoutDescribing,
  placementOf,
  releaseDistance,
  siblingLayouts,
} = require("../lib/release-layouts");
const { clearRecordLayoutCache, recordLayoutsFor } = require("../lib/record-layouts");
const path = require("node:path");

// Three releases of one record, in the shapes SOFiSTiK has actually shipped: a
// field appended to the end, a field inserted into the middle, and a field left
// where it was under a new name.
function headersFor(body) {
  return {
    "cdbtypetest.h": `
typedef struct tagCDB_PLATE {  /* 9/NR  a plate of a section */
${body}
} typeCDB_PLATE;

#define SECT_KWH 9
#define PLATE_ID 103
typedef union taguSECT {
int m_id;
typeCDB_PLATE m_plate;
} typeuSECT;
`,
  };
}

const RELEASES = {
  // Sixteen bytes: the form these releases describe.
  2018: headersFor("int m_idp;\nfloat m_ya;\nfloat m_za;\nfloat m_t;"),
  2020: headersFor("int m_idp;\nfloat m_ya;\nfloat m_za;\nfloat m_t;"),
  // The same four values, one of them renamed. The bytes do not move.
  2024: headersFor("int m_idp;\nfloat m_ya;\nfloat m_za;\nfloat m_thick;"),
  // A field appended: the record grows to twenty and everything before it stays
  // exactly where it was.
  2022: headersFor("int m_idp;\nfloat m_ya;\nfloat m_za;\nfloat m_t;\nint m_subid;"),
  2025: headersFor("int m_idp;\nfloat m_ya;\nfloat m_za;\nfloat m_t;\nint m_subid;"),
  2026: headersFor("int m_idp;\nfloat m_ya;\nfloat m_za;\nfloat m_t;\nint m_subid;"),
};

function layoutsOf(version) {
  return recordLayoutsFor(`C:/installed/SOFiSTiK ${version}`, {
    headerDirectory: `headers-${version}`,
    readdir: () => Object.keys(RELEASES[version]),
    readFile: (file) => RELEASES[version][path.basename(file)],
  });
}

function contextFor(version, others) {
  return {
    layouts: layoutsOf(version),
    version: String(version),
    siblings: others.map((other) => ({ version: String(other), layouts: layoutsOf(other) })),
  };
}

beforeEach(() => clearRecordLayoutCache());

describe("layoutDescribing", () => {
  it("uses this installation's own layout whenever it is the stored length", () => {
    const found = layoutDescribing(contextFor(2026, [2024]), "CDB_PLATE", 20);
    expect(found.layout.size).toBe(20);
    // Nothing was borrowed, so no release is named.
    expect(found.version).toBe(null);
  });

  it("borrows the layout of a release that describes the stored length", () => {
    // A 2026 installation reading a database an older release wrote. Without
    // this the 16-byte records match nothing and decode to nothing at all.
    const found = layoutDescribing(contextFor(2026, [2025, 2024, 2020, 2018]), "CDB_PLATE", 16);
    expect(found.layout.size).toBe(16);
    expect(found.layout.fields.map(({ name }) => name)).toEqual(["idp", "ya", "za", "thick"]);
    expect(found.version).toBe("2024");
    // The releases that describe those bytes exactly the same way.
    expect(found.alsoDescribedBy).toEqual(["2020", "2018"]);
  });

  it("reads a longer record than this release describes, from the release that does", () => {
    // The other direction: an older installation reading a newer database.
    const found = layoutDescribing(contextFor(2018, [2026, 2025, 2024]), "CDB_PLATE", 20);
    expect(found.layout.size).toBe(20);
    expect(found.layout.fields.map(({ name }) => name)).toContain("subid");
    expect(found.version).toBe("2025");
  });

  it("prefers the release nearest the one being read through, older before newer", () => {
    // A database is usually written by the release reading it or by one near it,
    // and one older than the interface is the ordinary case.
    // 2020 and 2024 are both two years from 2022 and describe those 16 bytes the
    // same way; the older one is the likelier writer.
    expect(layoutDescribing(contextFor(2022, [2024, 2020]), "CDB_PLATE", 16).version).toBe("2020");
    expect(releaseDistance("2020", "2022")).toBeLessThan(releaseDistance("2024", "2022"));
    expect(releaseDistance("2018", "2022")).toBeLessThan(releaseDistance("2026", "2022"));
    expect(releaseDistance("2022", "2022")).toBe(0);
    // A version that is not a year sorts last rather than winning by accident.
    expect(releaseDistance("beta", "2022")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("says nothing at all when no installed release describes the stored length", () => {
    expect(layoutDescribing(contextFor(2026, [2024]), "CDB_PLATE", 44)).toEqual({ layout: null });
    // Nor does a release that does not have the record contribute one.
    expect(layoutDescribing(contextFor(2026, []), "CDB_PLATE", 16)).toEqual({ layout: null });
  });

  it("refuses when two releases lay the stored length out differently", () => {
    const wider = {
      "cdbtypetest.h": RELEASES[2018]["cdbtypetest.h"].replace(
        "float m_ya;\nfloat m_za;\nfloat m_t;",
        "int m_ya;\nint m_za;\nint m_t;",
      ),
    };
    const context = contextFor(2026, [2024]);
    context.siblings.push({
      version: "2019",
      layouts: recordLayoutsFor("C:/installed/SOFiSTiK 2019", {
        headerDirectory: "headers-2019",
        readdir: () => Object.keys(wider),
        readFile: () => wider["cdbtypetest.h"],
      }),
    });
    const found = layoutDescribing(context, "CDB_PLATE", 16);
    expect(found.layout).toBe(null);
    expect(found.ambiguous).toEqual([["2024"], ["2019"]]);
  });

  it("counts a rename as the same layout, because the bytes do not move", () => {
    // 2018 calls the last float `t` and 2024 calls it `thick`. Refusing over a
    // name would refuse a record every release decodes to the same numbers.
    expect(placementOf(layoutsOf(2018).layout("CDB_PLATE"))).toBe(
      placementOf(layoutsOf(2024).layout("CDB_PLATE")),
    );
    expect(placementOf(layoutsOf(2026).layout("CDB_PLATE"))).not.toBe(
      placementOf(layoutsOf(2018).layout("CDB_PLATE")),
    );
  });
});

describe("siblingLayouts", () => {
  it("reads every release installed beside this one, newest first", () => {
    const installed = ["2026", "2025", "2024"];
    const siblings = siblingLayouts(
      {
        environmentRoot: "C:/installed",
        installRoot: path.join("C:/installed", "2025", "SOFiSTiK 2025"),
      },
      {
        exists: () => true,
        readdir: (directory) =>
          path.basename(String(directory)) === "installed"
            ? installed
            : Object.keys(RELEASES[2026]),
        readFile: (file) => RELEASES[2026][path.basename(file)],
      },
    );
    expect(siblings.map(({ version }) => version)).toEqual(["2026", "2024"]);
    expect(siblings[0].layouts.has("CDB_PLATE")).toBe(true);
  });

  it("has no siblings to ask when it was told no environment", () => {
    expect(siblingLayouts({ installRoot: "C:/installed/2026/SOFiSTiK 2026" })).toEqual([]);
  });
});
