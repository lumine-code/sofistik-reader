// What this library can read, as data.
//
// Adding a record kind is one entry. `key` is the name of the union in the
// SOFiSTiK headers that owns the CDB key - the primary key and the record kinds
// stored under it are read from there, never written down here. `items` is the
// record kind a caller wants, `envelope` the max/min pair some result keys lead
// with, and `parts` any further kind stored under the same key. `secondary`
// names what the secondary key means when the headers leave it open: a load
// case, a section number, a material number.
//
// Record kinds under one key are told apart by their length where that is
// unambiguous, and by `when` - a range over one of the record's leading ints -
// where it is not. The help states those conditions after the key: a cross
// section is stored under its beam with number 0, tendon stresses under a
// negative second int, thermal eigenstresses under a second int above 100000.

const RECORDS = Object.freeze({
  // Model
  system: { key: "SYST", items: "CDB_SYST" },
  nodes: { key: "NODE", items: "CDB_NODE" },
  beams: {
    key: "BEAM",
    items: "CDB_BEAM",
    parts: { sections: { record: "CDB_BEAM_SCT", when: { field: 0, min: 0, max: 0 } } },
  },
  designLines: {
    key: "DSLN",
    items: "CDB_DSLN",
    parts: { sections: { record: "CDB_DSLN_SCT", when: { field: 0, min: 0, max: 0 } } },
  },
  externalSections: {
    key: "BSCT",
    items: "CDB_BSCT",
    parts: { sections: { record: "CDB_BSCT_SCT", when: { field: 0, min: 0, max: 0 } } },
  },
  trusses: { key: "TRUS", items: "CDB_TRUS" },
  cables: { key: "CABL", items: "CDB_CABL" },
  springs: { key: "SPRI", items: "CDB_SPRI" },
  quads: { key: "QUAD", items: "CDB_QUAD" },
  brics: { key: "BRIC", items: "CDB_BRIC" },
  groups: { key: "GRP", items: "CDB_GRP" },

  // Definitions, read one number at a time
  // One section is one read: its properties and every shape it is described by
  // are stored under the same key, each kind with its own record length.
  section: {
    key: "SECT",
    items: "CDB_SECT",
    itemsWhen: { field: 0, min: 0, max: 0 },
    secondary: "section",
    parts: {
      rectangle: "CDB_SECT_REC",
      tube: "CDB_SECT_TUB",
      circle: "CDB_SECT_CIR",
      polygon: "CDB_SECT_PPT",
      layers: "CDB_SECT_LAY",
      profile: "CDB_SECT_PRO",
    },
  },
  material: { key: "MAT", items: "CDB_MAT", secondary: "material" },
  materialConcrete: { key: "MAT", items: "CDB_MAT_CONC", secondary: "material" },
  materialSteel: { key: "MAT", items: "CDB_MAT_STEE", secondary: "material" },
  loadCase: { key: "LC_CTRL", items: "CDB_LC_CTRL", secondary: "loadCase" },

  // Results, read one load case at a time.
  //
  // `continuation` marks the keys the help writes as "Z!", where a record
  // numbered 0 continues the element before it; `materialKey` marks the field
  // that bands a beam result by material, tendon, reinforcement or stress point;
  // `supports` marks the record that carries support reactions alongside its
  // displacements.
  nodeResults: {
    key: "N_DISP",
    items: "CDB_N_DISP",
    envelope: "CDB_N_DISPC",
    secondary: "loadCase",
    supports: true,
    // A node stores its support reactions only where it has them, so the same
    // kind is stored both long and short.
    merge: true,
  },
  beamForces: {
    key: "BEAM_FOC",
    items: "CDB_BEAM_FOR",
    envelope: "CDB_BEAM_FOC",
    secondary: "loadCase",
    continuation: true,
  },
  beamForcesWithoutPlate: {
    key: "BEAM_FTC",
    items: "CDB_BEAM_FTR",
    envelope: "CDB_BEAM_FTC",
    secondary: "loadCase",
    continuation: true,
  },
  beamStresses: {
    key: "BEAM_STC",
    items: "CDB_BEAM_STR",
    envelope: "CDB_BEAM_STC",
    // 105/LC:+:- stores tendon stresses, 105/LC:+:1????? thermal eigenstresses,
    // both under the same key as the cross-section stresses.
    parts: {
      tendons: { record: "CDB_BEAM_STT", when: { field: 1, max: -1 } },
      thermal: { record: "CDB_BEAM_TST", when: { field: 1, min: 100000 } },
    },
    secondary: "loadCase",
    continuation: true,
    materialKey: "mnr",
  },
  trussStresses: {
    key: "TRUS_ST0",
    items: "CDB_TRUS_STR",
    envelope: "CDB_TRUS_ST0",
    secondary: "loadCase",
  },
  cableStresses: {
    key: "CABL_ST0",
    items: "CDB_CABL_STR",
    envelope: "CDB_CABL_ST0",
    secondary: "loadCase",
  },
  designLineForces: {
    key: "DSLN_FTC",
    items: "CDB_DSLN_FTR",
    envelope: "CDB_DSLN_FTC",
    secondary: "loadCase",
    continuation: true,
  },
  externalSectionForces: {
    key: "BSCT_FOC",
    items: "CDB_BSCT_FOR",
    envelope: "CDB_BSCT_FOC",
    secondary: "loadCase",
    continuation: true,
  },
  trussForces: {
    key: "TRUS_RE0",
    items: "CDB_TRUS_RES",
    envelope: "CDB_TRUS_RE0",
    secondary: "loadCase",
  },
  cableForces: {
    key: "CABL_RE0",
    items: "CDB_CABL_RES",
    envelope: "CDB_CABL_RE0",
    secondary: "loadCase",
  },
  springResults: {
    key: "SPRI_RE0",
    items: "CDB_SPRI_RES",
    envelope: "CDB_SPRI_RE0",
    secondary: "loadCase",
  },
  quadForces: {
    key: "QUAD_FOC",
    items: "CDB_QUAD_FOR",
    envelope: "CDB_QUAD_FOC",
    secondary: "loadCase",
  },
  quadStresses: {
    key: "QUAD_STC",
    items: "CDB_QUAD_STR",
    envelope: "CDB_QUAD_STC",
    // 220/LC:- is the header of the nonlinear stress block.
    parts: { nonlinear: { record: "CDB_QUAD_STP", when: { field: 0, max: -1 } } },
    secondary: "loadCase",
  },
  quadDesignStresses: {
    key: "QUAD_DST",
    items: "CDB_QUAD_DST",
    envelope: "CDB_QUAD_DSC",
    secondary: "loadCase",
  },
  quadReinforcement: {
    key: "QUAD_RIC",
    items: "CDB_QUAD_REI",
    envelope: "CDB_QUAD_RIC",
    secondary: "loadCase",
  },
});

function recordDefinition(name) {
  const definition = RECORDS[name];
  if (!definition) {
    throw new RangeError(
      `Unknown SOFiSTiK record "${name}". Known records: ${Object.keys(RECORDS).join(", ")}.`,
    );
  }
  return definition;
}

// Every record kind one read has to make room for: CDB fills the buffer it is
// given, so the read is sized by the largest kind stored under the key.
function recordKindsOf(definition) {
  return [definition.items, definition.envelope, ...Object.values(definition.parts || {})].filter(
    Boolean,
  );
}

module.exports = { RECORDS, recordDefinition, recordKindsOf };
