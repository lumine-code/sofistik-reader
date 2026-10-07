const { fieldFactor, isKnownUnit, siFactor, storedUnit } = require("../lib");

describe("units", () => {
  it("passes through what a CDB already stores in SI", () => {
    // The help's own table: lengths, deformations and rotations are stored in
    // metres and radians whatever they are printed in.
    expect(siFactor(1001)).toBe(1);
    expect(siFactor(1003)).toBe(1);
    expect(siFactor(1004)).toBe(1);
    expect(storedUnit(1003)).toBe("m");
    expect(storedUnit(1004)).toBe("rad");
  });

  it("scales what it does not — a CDB keeps its forces in kilonewtons", () => {
    // This is the whole reason conversion exists. A modulus of 2.1e8 in a CDB
    // is 210 GPa, which is steel, and 2.1e8 N/m2 would be 210 MPa, which is not.
    expect(siFactor(1101)).toBe(1000);
    expect(siFactor(1151)).toBe(1000);
    expect(siFactor(1152)).toBe(1000);
    expect(siFactor(1090)).toBe(1000);
    expect(siFactor(1092)).toBe(1000);
    expect(siFactor(1095)).toBe(1000);
    expect(siFactor(1098)).toBe(1000);
    expect(storedUnit(1101)).toBe("kN");
    expect(storedUnit(1095)).toBe("kN/m");
    expect(storedUnit(1098)).toBe("kNm/rad");
    expect(2.1e8 * siFactor(1090)).toBe(2.1e11);
  });

  it("says what it does not know rather than guessing a factor", () => {
    expect(isKnownUnit(1003)).toBe(true);
    expect(isKnownUnit(1189)).toBe(false);
    expect(() => siFactor(1189)).toThrowError(/quantity 1189/);
    expect(() => fieldFactor({ fields: [{ name: "value", unit: 1189 }] }, "value")).toThrowError(
      /quantity 1189/,
    );
    expect(storedUnit(1189)).toBeNull();
    expect(siFactor(undefined)).toBe(1);
  });

  it("takes a field's quantity from the read it came in, not from its name", () => {
    // `x` is a length on one record and a station on another, `n` is a normal
    // force. Only the code the layout states can tell them apart.
    const read = {
      fields: [
        { name: "ux", kind: "f32", count: 1, unit: 1003 },
        { name: "n", kind: "f32", count: 1, unit: 1101 },
        { name: "nr", kind: "i32", count: 1 },
      ],
    };
    expect(fieldFactor(read, "ux")).toBe(1);
    expect(fieldFactor(read, "n")).toBe(1000);
    // A field that names no quantity, and a field that is not there at all.
    expect(fieldFactor(read, "nr")).toBe(1);
    expect(fieldFactor(read, "missing")).toBe(1);
    expect(fieldFactor(null, "ux")).toBe(1);
  });
});
