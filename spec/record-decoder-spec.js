const { decodeMerged, decodeRecords, toObjects } = require("../lib/record-decoder");

// Records are built here rather than read from a database, so the decoder is
// tested on every platform without SOFiSTiK installed.
const SAMPLE = {
  name: "CDB_SAMPLE",
  size: 24,
  alignment: 4,
  fields: [
    { name: "nr", kind: "i32", offset: 0, size: 4, count: 1, dimensions: [] },
    { name: "xyz", kind: "f32", offset: 4, size: 4, count: 3, dimensions: [3] },
    { name: "flag", kind: "i16", offset: 16, size: 2, count: 1, dimensions: [] },
    { name: "text", kind: "text", offset: 20, size: 4, count: 1, dimensions: [] },
  ],
};

const ENVELOPE = {
  name: "CDB_SAMPLE_MAX",
  size: 8,
  alignment: 4,
  fields: [
    { name: "nr", kind: "i32", offset: 0, size: 4, count: 1, dimensions: [] },
    { name: "peak", kind: "f32", offset: 4, size: 4, count: 1, dimensions: [] },
  ],
};

function read(records) {
  const lengths = records.map(({ layout }) => layout.size);
  const data = Buffer.alloc(lengths.reduce((total, length) => total + length, 0));
  let offset = 0;
  for (const { layout, values } of records) {
    for (const field of layout.fields) {
      const value = values[field.name];
      const items = Array.isArray(value) ? value : [value];
      items.forEach((item, index) => {
        const at = offset + field.offset + index * field.size;
        if (field.kind === "f32") data.writeFloatLE(item, at);
        else if (field.kind === "i16") data.writeInt16LE(item, at);
        else if (field.kind === "text") data.writeUInt32LE(item, at);
        else data.writeInt32LE(item, at);
      });
    }
    offset += layout.size;
  }
  return { count: records.length, lengths, data };
}

describe("decodeMerged", () => {
  it("merges the stored forms of one record kind back into record order", () => {
    // A node result carries its support reactions only where the node is
    // supported, so the same kind is stored both long and short.
    const source = read([
      { layout: SAMPLE, values: { nr: 1, xyz: [1, 2, 3], flag: 7, text: 0 } },
      { layout: ENVELOPE, values: { nr: 2, peak: 0 } },
      { layout: SAMPLE, values: { nr: 3, xyz: [4, 5, 6], flag: 8, text: 0 } },
      { layout: ENVELOPE, values: { nr: 4, peak: 0 } },
    ]);

    const merged = decodeMerged(SAMPLE, source);
    expect(merged.count).toBe(4);
    expect(Array.from(merged.columns.nr)).toEqual([1, 2, 3, 4]);
    // The short form stores nothing past its length, which reads as zero.
    expect(Array.from(merged.columns.xyz)).toEqual([1, 2, 3, 0, 0, 0, 4, 5, 6, 0, 0, 0]);
    expect(Array.from(merged.recordLengths)).toEqual([24, 8, 24, 8]);
    expect(merged.stored).toEqual([
      { length: 24, count: 2 },
      { length: 8, count: 2 },
    ]);
  });

  it("decodes one stored form without merging anything", () => {
    const source = read([{ layout: SAMPLE, values: { nr: 5, xyz: [0, 0, 0], flag: 0, text: 0 } }]);
    expect(decodeMerged(SAMPLE, source).count).toBe(1);
    expect(decodeMerged(SAMPLE, source).recordLengths).toBeUndefined();
  });
});

describe("decodeRecords", () => {
  it("decodes only the records a selection names", () => {
    // Several record kinds share a key and are told apart by their contents, not
    // their length: the caller passes the mask it worked out.
    const source = read([
      { layout: SAMPLE, values: { nr: 1, xyz: [1, 1, 1], flag: 0, text: 0 } },
      { layout: SAMPLE, values: { nr: 2, xyz: [2, 2, 2], flag: 0, text: 0 } },
      { layout: SAMPLE, values: { nr: 3, xyz: [3, 3, 3], flag: 0, text: 0 } },
    ]);
    const decoded = decodeRecords(SAMPLE, source, { select: Uint8Array.from([1, 0, 1]) });
    expect(Array.from(decoded.columns.nr)).toEqual([1, 3]);
    expect(Array.from(decoded.indices)).toEqual([0, 2]);
  });

  it("returns one typed-array column per field", () => {
    const decoded = decodeRecords(
      SAMPLE,
      read([
        { layout: SAMPLE, values: { nr: 7, xyz: [1.5, -2.5, 3.5], flag: -3, text: 0x41424344 } },
        { layout: SAMPLE, values: { nr: 9, xyz: [0, 0.5, 1], flag: 4, text: 0 } },
      ]),
    );

    expect(decoded.count).toBe(2);
    expect(decoded.columns.nr).toEqual(Int32Array.from([7, 9]));
    expect(decoded.columns.xyz).toEqual(Float32Array.from([1.5, -2.5, 3.5, 0, 0.5, 1]));
    expect(decoded.columns.flag).toEqual(Int16Array.from([-3, 4]));
    expect(decoded.columns.text).toEqual(Uint32Array.from([0x41424344, 0]));
    expect(decoded.fields).toEqual([
      { name: "nr", kind: "i32", count: 1 },
      { name: "xyz", kind: "f32", count: 3 },
      { name: "flag", kind: "i16", count: 1 },
      { name: "text", kind: "text", count: 1 },
    ]);
  });

  it("decodes only the records that match the layout and reports the rest", () => {
    // A results key leads with envelope records of a different shape; each pass
    // over the read picks out the kind it understands.
    const source = read([
      { layout: ENVELOPE, values: { nr: -1, peak: 12.5 } },
      { layout: SAMPLE, values: { nr: 1, xyz: [1, 2, 3], flag: 0, text: 0 } },
      { layout: SAMPLE, values: { nr: 2, xyz: [4, 5, 6], flag: 1, text: 0 } },
    ]);

    const items = decodeRecords(SAMPLE, source);
    expect(items.count).toBe(2);
    expect(items.columns.nr).toEqual(Int32Array.from([1, 2]));
    expect(items.skipped).toEqual([{ length: 8, count: 1 }]);

    const envelope = decodeRecords(ENVELOPE, source);
    expect(envelope.count).toBe(1);
    expect(envelope.columns.peak).toEqual(Float32Array.from([12.5]));
    expect(envelope.skipped).toEqual([{ length: 24, count: 2 }]);
  });

  it("builds plain objects only when asked", () => {
    const decoded = decodeRecords(
      SAMPLE,
      read([{ layout: SAMPLE, values: { nr: 5, xyz: [1, 2, 3], flag: 2, text: 9 } }]),
    );
    expect(toObjects(decoded)).toEqual([{ nr: 5, xyz: [1, 2, 3], flag: 2, text: 9 }]);
  });

  it("is empty for a key that holds nothing", () => {
    const decoded = decodeRecords(SAMPLE, read([]));
    expect(decoded.count).toBe(0);
    expect(decoded.columns.nr).toEqual(new Int32Array(0));
    expect(toObjects(decoded)).toEqual([]);
  });
});

describe("a decoded read crossing the worker boundary", () => {
  it("survives the structured clone the reply is sent through", () => {
    // The worker answers the parent process through v8.serialize. Anything it
    // cannot clone - a Map, a function, or a buffer whose memory belongs to the
    // addon rather than to V8 - fails there and nowhere else, which is why the
    // reply shape is asserted against the serializer itself.
    const serialize = require("node:v8").serialize;
    const decoded = decodeRecords(
      SAMPLE,
      read([{ layout: SAMPLE, values: { nr: 3, xyz: [1, 2, 3], flag: 1, text: 0 } }]),
    );
    const reply = { name: "sample", key: "42/0", ...decoded, envelope: null };
    expect(() => serialize(reply)).not.toThrow();
    expect(Array.from(require("node:v8").deserialize(serialize(reply)).columns.nr)).toEqual([3]);
  });
});
