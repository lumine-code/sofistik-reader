const {
  MATERIAL_KINDS,
  envelopeOf,
  mapResult,
  materialKeyOf,
  packedName,
  packedText,
} = require("../lib/results");

function kindOf(mnr) {
  return MATERIAL_KINDS[materialKeyOf(mnr).kind];
}

function packed(text) {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) {
    value |= text.charCodeAt(index) << (index * 8);
  }
  return value >>> 0;
}

function packedUnicode(text, codes) {
  const value = new Uint32Array(codes);
  for (let index = 0; index < text.length; index += 2) {
    const high = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
    value[index >> 1] = text.charCodeAt(index) | (high << 16);
  }
  return value;
}

describe("packedText", () => {
  it("reads two code units to the int, low half first", () => {
    // "Steel" as SOFiSTiK stores it, taken from a material title in a real
    // database: 0x00740053 is "St", and the zero half of the third int ends it.
    expect(packedText(Uint32Array.of(0x00740053, 0x00650065, 0x0000006c, 0, 0))).toBe("Steel");
    expect(packedText(packedUnicode("Steel", 17))).toBe("Steel");
  });

  it("keeps a code unit that no byte would hold", () => {
    for (const text of ["Brücke Süd", "Przemostienie", "Träger 30°", "мост", "橋梁"]) {
      expect(packedText(packedUnicode(text, 17))).toBe(text);
    }
  });

  it("reads a string that fills its field to the last code", () => {
    // Nothing terminates it, so the field width is what says where it ends.
    // sof_lib_ps2cs returns nothing at all for this one.
    const full = "A".repeat(34);
    expect(packedText(packedUnicode(full, 17))).toBe(full);
    expect(packedText(packedUnicode("B".repeat(33), 17))).toBe("B".repeat(33));
  });

  it("ends at the first zero half and drops the padding behind it", () => {
    expect(packedText(Uint32Array.of(0))).toBe("");
    expect(packedText(new Uint32Array(0))).toBe("");
    expect(packedText(packedUnicode("Deck  ", 17))).toBe("Deck");
    // A zero low half ends the string even when the int carries a high half.
    expect(packedText(Uint32Array.of(0x00420041, 0x00430000, 0))).toBe("AB");
  });
});

describe("materialKeyOf", () => {
  it("bands a beam result the way the help documents it", () => {
    // 105/LC: negative is a tendon, below 1024 admissible stresses, then the
    // maxima for the solid material, for tendons and for reinforcements.
    expect(kindOf(-7)).toBe("tendon");
    expect(materialKeyOf(-7).number).toBe(7);
    expect(kindOf(3)).toBe("admissible");
    expect(materialKeyOf(1024 + 5)).toEqual({ kind: 2, number: 5, name: null });
    expect(kindOf(1024 + 5)).toBe("material");
    expect(materialKeyOf(2048 + 2).number).toBe(2);
    expect(kindOf(2048 + 2)).toBe("tendonMaximum");
    expect(materialKeyOf(3072 + 9).number).toBe(9);
    expect(kindOf(3072 + 9)).toBe("reinforcement");
  });

  it("reads the four characters a stress point or a shear cut is named with", () => {
    expect(packedName(packed("SO"))).toBe("SO");
    expect(materialKeyOf(packed("SO"))).toEqual({ kind: 5, number: 0, name: "SO" });
    expect(kindOf(packed("SO"))).toBe("stressPoint");
    // A shear cut is written with a bar in the first position.
    expect(materialKeyOf(packed("|A1"))).toEqual({ kind: 6, number: 0, name: "A1" });
    expect(kindOf(packed("|A1"))).toBe("shearCut");
  });
});

describe("mapResult", () => {
  function decoded(columns, count) {
    return {
      count,
      fields: Object.keys(columns).map((name) => ({ name, kind: "f32", count: 1 })),
      columns,
    };
  }

  it("resolves the element a continued record belongs to", () => {
    // A record numbered 0 continues the element before it: the two banks of a
    // discontinuity share one station.
    const result = decoded({ nr: Int32Array.from([11, 0, 0, 12, 0, 13]) }, 6);
    mapResult({ continuation: true }, result);
    expect(Array.from(result.columns.element)).toEqual([11, 11, 11, 12, 12, 13]);
    expect(result.fields.at(-1)).toEqual({ name: "element", kind: "i32", count: 1 });
  });

  it("splits a beam result by what its material number means", () => {
    const result = decoded({ mnr: Int32Array.from([1024 + 3, -4, packed("|A1")]) }, 3);
    mapResult({ materialKey: "mnr" }, result);
    expect(Array.from(result.columns.materialKind)).toEqual([2, 0, 6]);
    expect(Array.from(result.columns.material)).toEqual([3, 4, 0]);
    expect(result.columns.materialName).toEqual([null, null, "A1"]);
  });

  it("marks the nodes that carry a support reaction", () => {
    // Reactions share the node record and are stored only where a node is
    // supported, so an unsupported node reads as zero throughout.
    const result = decoded(
      {
        px: Float32Array.from([0, 12.5, 0]),
        py: Float32Array.from([0, 0, 0]),
        mz: Float32Array.from([0, 0, -3]),
      },
      3,
    );
    mapResult({ supports: true }, result);
    expect(Array.from(result.columns.supported)).toEqual([0, 1, 1]);
  });
});

describe("envelopeOf", () => {
  it("returns the leading maximum and minimum as records, not as columns", () => {
    const envelope = envelopeOf({
      record: "CDB_BEAM_FOC",
      count: 2,
      fields: [
        { name: "n", kind: "f32", count: 1 },
        { name: "xyz", kind: "f32", count: 2 },
      ],
      columns: { n: Float32Array.from([9, -4]), xyz: Float32Array.from([1, 2, 3, 4]) },
    });
    expect(envelope).toEqual({
      max: { n: 9, xyz: [1, 2] },
      min: { n: -4, xyz: [3, 4] },
      record: "CDB_BEAM_FOC",
    });
    expect(envelopeOf(null)).toBeNull();
    expect(envelopeOf({ count: 0 })).toBeNull();
  });
});
