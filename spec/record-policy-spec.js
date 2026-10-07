const { decodeKind } = require("../lib/record-policy");

function layout(size = 12, offset = 4) {
  return {
    name: "TEST",
    size,
    fields: [
      { name: "nr", kind: "i32", offset: 0, size: 4, count: 1 },
      { name: "values", kind: "f32", offset, size: 4, count: (size - offset) / 4 },
    ],
  };
}
function read(lengths) {
  const data = Buffer.alloc(lengths.reduce((sum, value) => sum + value, 0));
  let offset = 0;
  lengths.forEach((length, index) => {
    data.writeInt32LE(index + 1, offset);
    for (let at = 4; at < length; at += 4) data.writeFloatLE(index * 10 + at, offset + at);
    offset += length;
  });
  return { data, lengths: Int32Array.from(lengths) };
}
function context(siblings = []) {
  return { version: "2026", layouts: { layout: () => layout() }, siblings: () => siblings };
}
function sibling(version, form) {
  return { version, layouts: { has: () => true, layout: () => form } };
}

describe("CDB decode policies", () => {
  it("uses a described sibling form before a variable tail or assumed prefix", () => {
    const earlier = layout(16, 8);
    const decoded = decodeKind(context([sibling("2024", earlier)]), layout(), read([16]), {
      decodePolicy: "assumed-prefix",
    });
    expect(Array.from(decoded.columns.values)).toEqual([8, 12]);
    expect(decoded.provenance).toEqual([{ length: 16, count: 1, mode: "exact", version: "2024" }]);
  });

  it("merges every described form in original order without losing larger records", () => {
    const decoded = decodeKind(
      context([sibling("2024", layout(16))]),
      layout(),
      read([8, 12, 16]),
      { variableTail: { before: "values", step: 4 } },
    );
    expect(decoded.count).toBe(3);
    expect(Array.from(decoded.columns.nr)).toEqual([1, 2, 3]);
    expect(Array.from(decoded.recordLengths)).toEqual([8, 12, 16]);
    expect(Array.from(decoded.columns.values)).toEqual([4, 0, 0, 14, 18, 0, 24, 28, 32]);
    expect(decoded.skipped).toEqual([]);
    expect(decoded.provenance.map(({ mode }) => mode)).toEqual(["variable-tail", "exact", "exact"]);
  });

  it("refuses an unknown larger record even when other records decode", () => {
    expect(() =>
      decodeKind(context(), layout(), read([8, 12, 16]), {
        variableTail: { before: "values", step: 4 },
      }),
    ).toThrowError(/16 bytes/);
  });

  it("allows only catalogued variable tails", () => {
    expect(() => decodeKind(context(), layout(), read([8]))).toThrowError(/8 bytes/);
    const known = decodeKind(context(), layout(), read([8]), {
      variableTail: { before: "values", step: 4 },
    });
    expect(known.provenance[0].mode).toBe("variable-tail");
    expect(known.partial.assumed).toBeUndefined();
  });

  it("refuses known short forms under the exact policy", () => {
    expect(() =>
      decodeKind(context(), layout(), read([8]), {
        decodePolicy: "exact",
        variableTail: { before: "values" },
      }),
    ).toThrowError(/8 bytes/);
  });

  it("marks an explicitly requested guessed prefix", () => {
    const decoded = decodeKind(context(), layout(), read([8]), { decodePolicy: "assumed-prefix" });
    expect(decoded.partial.assumed).toBe(true);
    expect(decoded.provenance[0].mode).toBe("assumed-prefix");
  });

  it("reports an unclassified optional part instead of discarding it", () => {
    const decoded = decodeKind(context(), layout(), read([16]), {
      isolated: true,
      allowUnclassified: true,
    });
    expect(decoded.count).toBe(0);
    expect(decoded.skipped).toEqual([{ length: 16, count: 1 }]);
    expect(decoded.provenance).toEqual([
      { length: 16, count: 1, mode: "unclassified", version: "2026" },
    ]);
    expect(() =>
      decodeKind(context(), layout(), read([16]), {
        isolated: true,
        allowUnclassified: true,
        decodePolicy: "exact",
      }),
    ).toThrowError(/16 bytes/);
  });

  it("keeps other union kinds out of this kind's columns", () => {
    const decoded = decodeKind(context(), layout(), read([12, 8]), {
      claims: new Map([[8, ["OTHER"]]]),
    });
    expect(decoded.count).toBe(1);
    expect(decoded.skipped).toEqual([{ length: 8, count: 1 }]);
  });

  it("refuses ambiguous placement rather than selecting a release arbitrarily", () => {
    expect(() =>
      decodeKind(
        context([sibling("2024", layout(16, 4)), sibling("2025", layout(16, 8))]),
        layout(),
        read([16]),
      ),
    ).toThrowError(/ambiguous/);
  });

  it("decodes an unaligned double through the portable reader", () => {
    const { decodeRecords } = require("../lib/record-decoder");
    const data = Buffer.alloc(28);
    data.writeDoubleLE(2.5, 8);
    data.writeDoubleLE(3.5, 20);
    const form = {
      name: "DOUBLE",
      size: 12,
      fields: [{ name: "value", kind: "f64", offset: 4, count: 1, size: 8 }],
    };
    const decoded = decodeRecords(form, {
      data: data.subarray(4),
      lengths: Int32Array.from([12, 12]),
    });
    expect(Array.from(decoded.columns.value)).toEqual([2.5, 3.5]);
  });
});
