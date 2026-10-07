const path = require("node:path");
const { EventEmitter } = require("node:events");
const { CdbBridgeClient } = require("../lib/bridge-client");

function fakeBridge() {
  const child = new EventEmitter();
  child.send = jasmine.createSpy("send");
  child.kill = jasmine.createSpy("kill").and.callFake(() => {
    child.emit("exit", 0);
  });
  return {
    child,
    bridge: new CdbBridgeClient({ fork: () => child, requestTimeoutMs: 50, shutdownTimeoutMs: 50 }),
  };
}

describe("CdbBridgeClient lifecycle", () => {
  it("rejects all work and future requests when the worker exits", async () => {
    const { child, bridge } = fakeBridge();
    const first = bridge.request("records");
    const second = bridge.request("keys");
    child.emit("exit", 23);
    await expectAsync(first).toBeRejectedWithError(/23/);
    await expectAsync(second).toBeRejectedWithError(/23/);
    await expectAsync(bridge.request("keys")).toBeRejectedWithError(/23/);
    expect(bridge.pending.size).toBe(0);
    await bridge.dispose();
  });

  it("terminates a stuck native request at its deadline", async () => {
    const { child, bridge } = fakeBridge();
    await expectAsync(bridge.request("records", { timeoutMs: 10 })).toBeRejectedWithError(
      /exceeded/,
    );
    expect(child.kill).toHaveBeenCalled();
    expect(bridge.pending.size).toBe(0);
    await expectAsync(bridge.request("keys")).toBeRejectedWithError(/exceeded/);
    await bridge.dispose();
  });

  it("cancels by terminating the process that owns synchronous native state", async () => {
    const { child, bridge } = fakeBridge();
    const controller = new AbortController();
    const result = bridge.request("records", { signal: controller.signal });
    controller.abort(new Error("Cancelled read"));
    await expectAsync(result).toBeRejectedWithError("Cancelled read");
    expect(child.kill).toHaveBeenCalled();
    expect(bridge.pending.size).toBe(0);
    await bridge.dispose();
  });

  it("cleans up a synchronous send failure", async () => {
    const { child, bridge } = fakeBridge();
    child.send.and.throwError("IPC closed");
    await expectAsync(bridge.request("records")).toBeRejectedWithError("IPC closed");
    expect(bridge.pending.size).toBe(0);
    await bridge.dispose();
  });
});

describe("real CDB worker IPC", () => {
  let bridge;
  beforeEach(() => {
    bridge = new CdbBridgeClient({
      workerPath: path.join(__dirname, "fixtures", "worker.js"),
      requestTimeoutMs: 2000,
    });
  });
  afterEach(async () => {
    await bridge.dispose();
  });

  it("clones columns and keys, preserves errors, and closes readers independently", async () => {
    const first = await bridge.request("open");
    const second = await bridge.request("open");
    const read = await bridge.request("records", { readerId: first, payload: { name: "nodes" } });
    expect(Array.from(read.columns.xyz)).toEqual([1, 2, 3]);
    expect(read.columns.nr instanceof Int32Array).toBe(true);
    expect(
      Array.from(await bridge.request("keys", { readerId: second, payload: { name: "loadCase" } })),
    ).toEqual([101, 102]);
    const failure = await bridge
      .request("records", { readerId: first, payload: { name: "invalid" } })
      .catch((error) => error);
    expect(failure instanceof RangeError).toBe(true);
    expect(failure.code).toBe("ERR_CDB_RECORD_UNAVAILABLE");
    await bridge.request("close", { readerId: first });
    await expectAsync(
      bridge.request("keys", { readerId: first, payload: { name: "loadCase" } }),
    ).toBeRejectedWithError(/closed/);
    expect(
      (await bridge.request("records", { readerId: second, payload: { name: "nodes" } })).count,
    ).toBe(1);
  });

  it("rejects on a worker crash and remains terminal", async () => {
    const readerId = await bridge.request("open");
    await expectAsync(
      bridge.request("records", { readerId, payload: { name: "crash" } }),
    ).toBeRejected();
    await expectAsync(bridge.request("open")).toBeRejected();
  });

  it("kills a blocked native call and completes disposal", async () => {
    const readerId = await bridge.request("open");
    await expectAsync(
      bridge.request("records", { readerId, payload: { name: "block" }, timeoutMs: 20 }),
    ).toBeRejectedWithError(/exceeded/);
    await bridge.dispose();
    expect(bridge.pending.size).toBe(0);
  });
});
