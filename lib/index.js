const { CdbDatabase } = require("./cdb-database");
const { RECORDS } = require("./records");
const { toObjects } = require("./record-decoder");
const { MATERIAL_KINDS, materialKeyOf, packedName, secondaryGroupSelection } = require("./results");
const { DECODE_POLICIES } = require("./record-policy");
const { SECTION_FLAGS, SHELL_FLAGS, groupOf, restraintMask } = require("./cdb-semantics");
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
  DECODE_POLICIES,
  DEFAULT_ENVIRONMENT_ROOT,
  MATERIAL_KINDS,
  RECORDS,
  SECTION_FLAGS,
  SHELL_FLAGS,
  groupOf,
  listInterfaces,
  openDatabase,
  materialKeyOf,
  packedName,
  restraintMask,
  secondaryGroupSelection,
  resolveInterface,
  toObjects,
};
