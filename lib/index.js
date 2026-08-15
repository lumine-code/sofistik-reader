const { CdbDatabase } = require("./cdb-database");
const { RECORDS } = require("./records");
const { toObjects } = require("./record-decoder");
const { MATERIAL_KINDS, materialKeyOf } = require("./results");
const {
  DEFAULT_ENVIRONMENT_ROOT,
  listInterfaces,
  resolveInterface,
} = require("./sofistik-interface");

function openDatabase(databasePath, options) {
  return new CdbDatabase(databasePath, options);
}

module.exports = {
  CdbDatabase,
  DEFAULT_ENVIRONMENT_ROOT,
  MATERIAL_KINDS,
  RECORDS,
  listInterfaces,
  openDatabase,
  materialKeyOf,
  resolveInterface,
  toObjects,
};
