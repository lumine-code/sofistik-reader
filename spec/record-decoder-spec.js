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

// `length` writes a record CDB stopped short of its layout, which is how a
// trailing array reaches a database: filled to whatever the model needed.
function read(records) {
  const lengths = records.map(({ layout, length }) => length ?? layout.size);
  const data = Buffer.alloc(lengths.reduce((total, length) => total + length, 0));
  let offset = 0;
  records.forEach(({ layout, values }, record) => {
    const end = offset + lengths[record];
    for (const field of layout.fields) {
      const value = values[field.name];
      if (value === undefined) continue;
      const items = Array.isArray(value) ? value : [value];
      items.forEach((item, index) => {
        const at = offset + field.offset + index * field.size;
        if (at + field.size > end) return;
        if (field.kind === "f32") data.writeFloatLE(item, at);
        else if (field.kind === "i16") data.writeInt16LE(item, at);
        else if (field.kind === "text") data.writeUInt32LE(item, at);
        else data.writeInt32LE(item, at);
      });
    }
    offset += lengths[record];
  });
  return { count: records.length, lengths, data };
}

// A head and a long trailing array, the shape CDB truncates: a thermal
// eigenstress record declares 256 temperatures and stores as few as six.
const TRAILING = {
  name: "CDB_TRAILING",
  size: 48,
  alignment: 4,
  fields: [
    { name: "nr", kind: "i32", offset: 0, size: 4, count: 1, dimensions: [] },
    { name: "x", kind: "f32", offset: 4, size: 4, count: 1, dimensions: [] },
    { name: "ts", kind: "f32", offset: 8, size: 4, count: 8, dimensions: [8] },
    { name: "tail", kind: "i32", offset: 40, size: 4, count: 2, dimensions: [2] },
  ],
};

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

  it("gives one column the widest form's shape, however far each form was cut", () => {
    // The same kind stored twice, its trailing array filled to a different
    // length each time. The merged column is as wide as the widest form and a
    // shorter one writes what it has into the front of its own slot.
    const source = read([
      { layout: TRAILING, length: 28, values: { nr: 1, x: 0, ts: [1, 2, 3, 4, 5, 6, 7, 8] } },
      { layout: TRAILING, length: 16, values: { nr: 2, x: 0, ts: [9, 8, 7, 6, 5, 4, 3, 2] } },
      { layout: TRAILING, length: 28, values: { nr: 3, x: 0, ts: [4, 4, 4, 4, 4, 4, 4, 4] } },
    ]);

    const merged = decodeMerged(TRAILING, source);
    expect(merged.count).toBe(3);
    expect(Array.from(merged.columns.nr)).toEqual([1, 2, 3]);
    expect(merged.fields.find(({ name }) => name === "ts").count).toBe(5);
    // Five elements a slot: the short record's two, then zeros for what it did
    // not store - which is what CDB means by not storing them.
    expect(Array.from(merged.columns.ts)).toEqual([1, 2, 3, 4, 5, 9, 8, 0, 0, 0, 4, 4, 4, 4, 4]);
    expect(Array.from(merged.recordLengths)).toEqual([28, 16, 28]);
    expect(merged.partial.shortened).toEqual([{ name: "ts", count: 5, of: 8 }]);
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

  it("keeps the elements of an array a truncated record does reach", () => {
    // Stored at 20 bytes: the head, then three of the eight temperatures. The
    // three are in the database and are as real as any other value in it.
    const source = read([
      { layout: TRAILING, length: 20, values: { nr: 5, x: 1.5, ts: [1, 2, 3, 9, 9, 9, 9, 9] } },
    ]);
    const decoded = decodeRecords(TRAILING, source, { storedLength: 20 });

    expect(decoded.count).toBe(1);
    expect(decoded.columns.ts).toEqual(Float32Array.from([1, 2, 3]));
    expect(decoded.fields).toEqual([
      { name: "nr", kind: "i32", count: 1 },
      { name: "x", kind: "f32", count: 1 },
      { name: "ts", kind: "f32", count: 3 },
    ]);
    // A field the record cuts short and one it never begins are different
    // things, and are reported as different things.
    expect(decoded.partial).toEqual({
      storedLength: 20,
      layoutLength: 48,
      dropped: ["tail"],
      shortened: [{ name: "ts", count: 3, of: 8 }],
    });
    // The count a caller indexes by is the truncated one.
    expect(toObjects(decoded)).toEqual([{ nr: 5, x: 1.5, ts: [1, 2, 3] }]);
  });

  it("counts only the elements a record holds whole", () => {
    // Two floats fit in the eleven bytes past the head; the third is cut across
    // the end and is not a float.
    const decoded = decodeRecords(TRAILING, read([{ layout: TRAILING, length: 19, values: {} }]), {
      storedLength: 19,
    });
    expect(decoded.partial.shortened).toEqual([{ name: "ts", count: 2, of: 8 }]);
  });

  it("says nothing was cut short when nothing was", () => {
    const whole = decodeRecords(TRAILING, read([{ layout: TRAILING, values: {} }]));
    expect(whole.partial).toBe(null);
    // A record that ends exactly where a field begins drops it rather than
    // keeping nothing of it.
    const decoded = decodeRecords(TRAILING, read([{ layout: TRAILING, length: 8, values: {} }]), {
      storedLength: 8,
    });
    expect(decoded.partial).toEqual({
      storedLength: 8,
      layoutLength: 48,
      dropped: ["ts", "tail"],
    });
  });

  it("leaves the layout it was handed alone", () => {
    // Layouts belong to the installation and are shared by every read of it.
    decodeRecords(TRAILING, read([{ layout: TRAILING, length: 20, values: {} }]), {
      storedLength: 20,
    });
    expect(TRAILING.fields.find(({ name }) => name === "ts").count).toBe(8);
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
