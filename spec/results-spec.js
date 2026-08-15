const {
  MATERIAL_KINDS,
  envelopeOf,
  mapResult,
  materialKeyOf,
  packedName,
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
