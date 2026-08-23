const {
  conditionsOf,
  holds,
  leadingWords,
  narrow,
  selectionsFor,
  wordsNeeded,
} = require("../lib/record-selection");
const { RECORDS, recordKindsOf } = require("../lib/records");

// A read as the native reader hands it over: the length CDB reported for each
// record, and every record's bytes end to end.
function readOf(records) {
  const lengths = records.map(({ length }) => length);
  const data = Buffer.alloc(lengths.reduce((total, length) => total + length, 0));
  let position = 0;
  for (const { length, ints = [] } of records) {
    ints.forEach((value, word) => {
      if (word * 4 + 4 <= length) data.writeInt32LE(value, position + word * 4);
    });
    position += length;
  }
  return { lengths: Int32Array.from(lengths), data, count: records.length };
}

function selected(mask) {
  return [...mask].flatMap((taken, index) => (taken ? [index] : []));
}

describe("conditionsOf", () => {
  it("takes one condition or several, and nothing at all", () => {
    const one = { field: 0, min: 1, max: 1 };
    expect(conditionsOf(one)).toEqual([one]);
    expect(conditionsOf([one, { field: 1, min: 2000, max: 2999 }]).length).toBe(2);
    expect(conditionsOf(null)).toEqual([]);
    expect(conditionsOf(undefined)).toEqual([]);
  });

  it("reads only as many leading ints as the conditions reach for", () => {
    expect(wordsNeeded([{ field: 0, min: 1 }])).toBe(1);
    expect(
      wordsNeeded([
        { field: 0, min: 1 },
        { field: 1, max: 9 },
      ]),
    ).toBe(2);
    // A condition with no field named is about the first int.
    expect(wordsNeeded([{ min: 1 }])).toBe(1);
    expect(wordsNeeded([])).toBe(0);
  });
});

describe("holds", () => {
  it("requires every condition, not any of them", () => {
    const steel = [
      { field: 0, min: 1, max: 1 },
      { field: 1, min: 2000, max: 2999 },
    ];
    expect(holds(steel, [1, 2002])).toBe(true);
    // The right id and the wrong band: a concrete material, which is exactly
    // what one condition on the id alone would have let through.
    expect(holds(steel, [1, 1000])).toBe(false);
    // The right band under another id: an explicit creep curve is 90, not 1.
    expect(holds(steel, [90, 2002])).toBe(false);
  });

  it("treats a missing bound as no bound at all", () => {
    expect(holds([{ field: 1, max: -1 }], [0, -7])).toBe(true);
    expect(holds([{ field: 1, min: 100000 }], [0, 100001])).toBe(true);
    expect(holds([{ field: 1, min: 100000 }], [0, 99999])).toBe(false);
  });
});

describe("leadingWords", () => {
  it("reads an int a record is too short to hold as zero", () => {
    // Which is what CDB means by not storing it: a truncated record simply ends.
    const read = readOf([{ length: 4, ints: [7] }]);
    expect(leadingWords(read, 0, 4, 3)).toEqual([7, 0, 0]);
  });
});

describe("narrow", () => {
  it("keeps the records a condition admits and no others", () => {
    const read = readOf([
      { length: 80, ints: [0, 2002] },
      { length: 140, ints: [1, 2002] },
      { length: 140, ints: [1, 1000] },
    ]);
    expect(selected(narrow(null, read, { field: 0, min: 0, max: 0 }))).toEqual([0]);
    expect(
      selected(
        narrow(null, read, [
          { field: 0, min: 1, max: 1 },
          { field: 1, min: 2000, max: 2999 },
        ]),
      ),
    ).toEqual([1]);
  });

  it("narrows a mask rather than replacing it, and leaves it alone with no condition", () => {
    const read = readOf([
      { length: 140, ints: [1, 2002] },
      { length: 140, ints: [1, 2000] },
    ]);
    const mask = Uint8Array.from([0, 1]);
    expect(selected(narrow(mask, read, { field: 0, min: 1, max: 1 }))).toEqual([1]);
    // And the mask it was handed is not written through.
    expect([...mask]).toEqual([0, 1]);
    expect(narrow(mask, read, null)).toBe(mask);
  });
});

describe("selectionsFor", () => {
  it("gives each record to the first kind that claims it", () => {
    // A fluid's band lies inside the constants' band, so the order the catalog
    // declares them in is what keeps the two apart.
    const variants = [
      {
        when: [
          { field: 0, min: 1, max: 1 },
          { field: 1, min: 800, max: 899 },
        ],
      },
      {
        when: [
          { field: 0, min: 1, max: 1 },
          { field: 1, min: 0, max: 999 },
        ],
      },
    ];
    const read = readOf([
      { length: 40, ints: [1, 801] },
      { length: 140, ints: [1, 0] },
    ]);
    const { masks, items } = selectionsFor(read, variants);
    expect(selected(masks[0])).toEqual([0]);
    expect(selected(masks[1])).toEqual([1]);
    // Nothing is left over for the items record.
    expect(selected(items)).toEqual([]);
  });

  it("leaves the records no kind claimed to the items record", () => {
    const variants = [{ when: { field: 0, min: 1, max: 1 } }];
    const read = readOf([
      { length: 80, ints: [0, 2002] },
      { length: 140, ints: [1, 2002] },
    ]);
    const { masks, items } = selectionsFor(read, variants);
    expect(selected(masks[0])).toEqual([1]);
    expect(selected(items)).toEqual([0]);
  });

  it("has nothing to select when a key holds one kind", () => {
    expect(selectionsFor(readOf([{ length: 28 }]), [])).toBe(null);
  });
});

describe("the material catalog", () => {
  const parts = Object.entries(RECORDS.material.parts);
  const bandOf = (when) => when.find(({ field }) => field === 1);

  it("tells every kind apart by the id and the type together", () => {
    // Neither alone would do it: the five properties records share the id 1,
    // and an explicit creep curve shares a type band with the constants.
    for (const [, { when }] of parts) {
      expect(when.length).toBe(2);
      expect(when[0]).toEqual({ field: 0, min: 1, max: 1 });
      expect(bandOf(when)).toBeDefined();
    }
  });

  it("declares a band that lies inside another before the one that contains it", () => {
    // The first kind whose condition holds takes the record, so a fluid
    // declared after the constants would never be read as one.
    parts.forEach(([name, { when }], order) => {
      const band = bandOf(when);
      const later = parts.slice(order + 1);
      for (const [otherName, other] of later) {
        const otherBand = bandOf(other.when);
        const contains = otherBand.min >= band.min && otherBand.max <= band.max;
        expect(contains)
          .withContext(`${name} contains ${otherName}, so ${otherName} can never be read`)
          .toBe(false);
      }
    });
  });

  it("reads the title record itself, and only it, as the material", () => {
    expect(RECORDS.material.items).toBe("CDB_MAT");
    expect(RECORDS.material.itemsWhen).toEqual({ field: 0, min: 0, max: 0 });
    expect(RECORDS.material.secondary).toBe("material");
  });

  it("names a band for each kind the help documents", () => {
    // 001/NR:1:0???, :08??, :1???, :2???, :3??? and :1????? - the bands
    // SOFiSTiK states beside the key, unchanged since 2018.
    expect(
      Object.fromEntries(
        parts.map(([name, { when }]) => [name, [bandOf(when).min, bandOf(when).max]]),
      ),
    ).toEqual({
      fluid: [800, 899],
      constants: [0, 999],
      concrete: [1000, 1999],
      steel: [2000, 2999],
      timber: [3000, 3999],
      brickwork: [100000, 199999],
    });
  });

  it("names every record kind it reads, and names them", () => {
    // A part written with a condition is a descriptor, and what an entry names
    // is the record inside it rather than the descriptor around it.
    expect(recordKindsOf(RECORDS.material)).toEqual([
      "CDB_MAT",
      "CDB_MAT_FLUI",
      "CDB_MAT_CONS",
      "CDB_MAT_CONC",
      "CDB_MAT_STEE",
      "CDB_MAT_TIMB",
      "CDB_MAT_BRIC",
    ]);
    // The same for every entry, whichever form its parts take.
    for (const definition of Object.values(RECORDS)) {
      expect(recordKindsOf(definition).every((kind) => typeof kind === "string")).toBe(true);
    }
    expect(recordKindsOf(RECORDS.beamStresses)).toContain("CDB_BEAM_TST");
    expect(recordKindsOf(RECORDS.nodes)).toEqual(["CDB_NODE"]);
  });

  it("no longer offers a kind a caller has to choose blind", () => {
    expect(RECORDS.materialConcrete).toBeUndefined();
    expect(RECORDS.materialSteel).toBeUndefined();
  });
});

describe("the load case catalog", () => {
  it("tells a superposition and an eigenmode from the load case they share a length with", () => {
    // All three are 188 bytes under one key, so the leading int is the whole of
    // what separates them; without these a superposition would be read through
    // the plain load case's layout and its envelope kind would come back as a
    // theory of second order.
    const parts = RECORDS.loadCase.parts;
    expect(parts.superposition.when).toEqual({ field: 0, min: 2, max: 2 });
    expect(parts.eigenmode.when).toEqual({ field: 0, min: 4, max: 4 });
    expect(parts.superposition.record).toBe("CDB_LC_SUPE");
    expect(parts.eigenmode.record).toBe("CDB_LC_EIGE");

    const variants = Object.values(parts).map(({ when }) => ({ when }));
    const read = readOf([
      { length: 188, ints: [0] }, // a linear load case
      { length: 188, ints: [2] }, // a superposition
      { length: 188, ints: [4] }, // an eigenmode
    ]);
    const { masks, items } = selectionsFor(read, variants);
    expect(selected(masks[0])).toEqual([1]);
    expect(selected(masks[1])).toEqual([2]);
    // The load case itself is what neither of them claimed.
    expect(selected(items)).toEqual([0]);
  });
});

describe("the group and control catalog", () => {
  it("merges the per-element-type group record back into the group", () => {
    // The help: "for each group and each element type will exist a record".
    // That short form is the same kind cut off, not a kind of its own, so
    // merging is what keeps it from being dropped as an unrecognised length.
    expect(RECORDS.groups.merge).toBe(true);
    expect(RECORDS.groups.parts).toBeUndefined();
  });

  it("reads the control record the unit set is stored in", () => {
    // Field codes name what a column holds; the set names what it is held in.
    // Neither answers on its own, so the record that carries the set is read.
    expect(RECORDS.control).toEqual({ key: "CTRL", items: "CDB_CTRL" });
    expect(RECORDS.control.secondary).toBeUndefined();
  });
});
