// Owns native sessions and the IPC protocol, independently of record decoding.
function serveWorker(channel, createReader) {
  const readers = new Map();
  let nextReaderId = 1;
  const closeAll = () => {
    for (const reader of readers.values()) reader.close();
    readers.clear();
  };
  const dispatch = ({ operation, readerId, payload }) => {
    if (operation === "open") {
      const id = nextReaderId++;
      readers.set(id, createReader(payload));
      return id;
    }
    const reader = readers.get(readerId);
    if (!reader) throw new Error("The SOFiSTiK CDB reader is closed.");
    if (operation === "records") return reader.read(payload);
    if (operation === "keys") return reader.keys(payload.name);
    if (operation === "close") {
      reader.close();
      readers.delete(readerId);
      return true;
    }
    throw new RangeError(`Unknown SOFiSTiK worker operation: ${operation}`);
  };
  channel.on("message", (message) => {
    let reply;
    try {
      reply = { id: message.id, value: dispatch(message) };
    } catch (error) {
      reply = {
        id: message.id,
        error: { name: error.name, message: error.message, code: error.code },
      };
    }
    // Disconnecting while a native read runs prevents delivery. Native cleanup
    // still runs through the disconnect handler once the read returns.
    if (channel.connected !== false) channel.send(reply, () => {});
  });
  channel.on("disconnect", closeAll);
  channel.on("exit", closeAll);
  return { dispatch, closeAll };
}

module.exports = { serveWorker };
