const { CdbDatabase } = require("./cdb-database");
const { RECORDS } = require("./records");
const { toObjects } = require("./record-decoder");
const { MATERIAL_KINDS, materialKeyOf, packedName, secondaryGroupSelection } = require("./results");
const { fieldFactor, isKnownUnit, siFactor, storedUnit } = require("./units");
const { DECODE_POLICIES } = require("./record-policy");
const {
  GROUP_FLAGS,
  SECTION_FLAGS,
  SHELL_FLAGS,
  couplingGroupOf,
  groupOf,
  restraintMask,
} = require("./cdb-semantics");
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
  GROUP_FLAGS,
  MATERIAL_KINDS,
  RECORDS,
  SECTION_FLAGS,
  SHELL_FLAGS,
  couplingGroupOf,
  groupOf,
  fieldFactor,
  isKnownUnit,
  siFactor,
  storedUnit,
  listInterfaces,
  openDatabase,
  materialKeyOf,
  packedName,
  restraintMask,
  secondaryGroupSelection,
  resolveInterface,
  toObjects,
};
