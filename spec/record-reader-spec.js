const { CdbRecordReader } = require("../lib/record-reader");
const { serveWorker } = require("../lib/worker-runtime");
const { EventEmitter } = require("node:events");

const field = (name, offset, kind = "i32") => ({ name, offset, kind, size: 4, count: 1 });
function fixtures() {
  const forms = {
    CDB_BEAM: { name: "CDB_BEAM", size: 8, fields: [field("nr", 0), field("value", 4, "f32")] },
    CDB_BEAM_SCT: {
      name: "CDB_BEAM_SCT",
      size: 12,
      fields: [field("id", 0), field("nq", 4), field("x", 8, "f32")],
    },
  };
  const data = Buffer.alloc(40);
  data.writeInt32LE(1, 0);
  data.writeInt32LE(11, 12);
  data.writeInt32LE(2, 20);
  data.writeInt32LE(22, 32);
  const native = {
    read: jasmine
      .createSpy("read")
      .and.returnValue({ data, lengths: Int32Array.from([8, 12, 8, 12]) }),
    keys: jasmine.createSpy("keys").and.returnValue(Int32Array.of(0)),
    close: jasmine.createSpy("close"),
  };
  const layouts = {
    layout(name) {
      return forms[name];
    },
    has(name) {
      return Boolean(forms[name]);
    },
    id() {
      return null;
    },
    key(name) {
      if (name !== "BEAM") throw new RangeError("Missing key");
      return { name, primary: 100, secondary: 0, variants: Object.keys(forms) };
    },
  };
  return {
    reader: new CdbRecordReader(native, { layouts, siblings: [], version: "2026" }),
    native,
  };
}

describe("CdbRecordReader", () => {
  it("selects parts and attaches owners through the full decoding pipeline", () => {
    const { reader, native } = fixtures();
    const read = reader.read({ name: "beams" });
    expect(read.key).toBe("100/0");
    expect(read.count).toBe(2);
    expect(Array.from(read.sections.columns.nq)).toEqual([11, 22]);
    expect(Array.from(read.sections.owners)).toEqual([1, 2]);
    expect(read.sections.provenance[0].mode).toBe("exact");
    expect(native.read).toHaveBeenCalledWith(100, 0, 12);
  });
  it("queries keys without decoding record data", () => {
    const { reader, native } = fixtures();
    expect(Array.from(reader.keys("beams"))).toEqual([0]);
    expect(native.read).not.toHaveBeenCalled();
    expect(native.keys).toHaveBeenCalledWith(100);
  });
  it("distinguishes unavailable records from data corruption", () => {
    const { reader } = fixtures();
    let failure;
    try {
      reader.read({ name: "designLines" });
    } catch (error) {
      failure = error;
    }
    expect(failure.code).toBe("ERR_CDB_RECORD_UNAVAILABLE");
  });
});

describe("worker native ownership", () => {
  it("closes every live reader once on disconnect and exit", () => {
    const channel = new EventEmitter();
    channel.send = jasmine.createSpy("send");
    const first = { close: jasmine.createSpy("first close") };
    const second = { close: jasmine.createSpy("second close") };
    const readers = [first, second];
    const runtime = serveWorker(channel, () => readers.shift());
    runtime.dispatch({ operation: "open" });
    runtime.dispatch({ operation: "open" });
    channel.emit("disconnect");
    channel.emit("exit");
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
  });
});
