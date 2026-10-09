const { couplingGroupOf } = require("../lib");

describe("kinematic constraint group encoding", () => {
  it("reads the group independently of the constraint type and depth", () => {
    expect(couplingGroupOf(550020)).toBe(55);
    expect(couplingGroupOf(559920)).toBe(55);
    expect(couplingGroupOf(600021)).toBe(60);
    expect(couplingGroupOf(9999992)).toBe(999);
  });

  it("retains group zero for ungrouped constraints", () => {
    expect(couplingGroupOf(0)).toBe(0);
    expect(couplingGroupOf(9920)).toBe(0);
  });

  it("rejects invalid packed constraint numbers", () => {
    for (const value of [-1, 550020.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, null, "550020"])
      expect(couplingGroupOf(value)).toBeNull();
  });
});
