const path = require("node:path");
const { CdbRecordReader } = require("./record-reader");
const { serveWorker } = require("./worker-runtime");

function createReader(options) {
  const searchDirectories = [path.dirname(options.dllPath), options.installRoot];
  process.env.PATH = `${searchDirectories.join(path.delimiter)}${path.delimiter}${process.env.PATH || ""}`;
  const { CdbReader } = require("./native-addon").loadNativeAddon();
  return new CdbRecordReader(new CdbReader(options.databasePath, options.dllPath), options);
}

serveWorker(process, createReader);
