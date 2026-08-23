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
// unambiguous, and by `when` where it is not - a range over one of the record's
// leading ints, or several ranges that must all hold. The help states those
// conditions after the key and this says the same thing: a cross section is
// stored under its beam with number 0, tendon stresses under a negative second
// int, thermal eigenstresses under a second int above 100000, a steel material
// under a first int of 1 and a second in the two thousands. Two of them are
// needed where neither alone separates a kind from every other under its key.

// A record kind whose id is shared with others and whose type decides which one
// it is. The help spells that pair after the key, in that order - 001/NR:1:2???
// is a steel material, an id of 1 and then a type anywhere in the two thousands
// - and the bands are written here as the numbers those digits stand for.
function idThenType(id, lowestType, highestType) {
  return [
    { field: 0, min: id, max: id },
    { field: 1, min: lowestType, max: highestType },
  ];
}

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
  // A coupling is a kinematic constraint held under the node key rather than an
  // element of its own, and SOFiSTiK declares no union for it, so it states its
  // key: 21/00, the standard constraint.
  couplings: {
    key: { primary: 21, secondary: 0, variants: ["CDB_NODE_KIN"] },
    items: "CDB_NODE_KIN",
  },
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
      // A thin-walled section is stored as the plates it is welded from and
      // the welds between them, both under one key and the same length, told
      // apart by the id each kind declares.
      panels: "CDB_SECT_PAN",
      welds: "CDB_SECT_WEL",
      // The areas of a section that do not carry, each a rectangle over the
      // shape rather than a piece of it.
      nonEffective: "CDB_SECT_NER",
      layers: "CDB_SECT_LAY",
      profile: "CDB_SECT_PRO",
    },
  },
  // One material is one read, for the reason a section is: its title and the
  // properties record that says what it is made of are stored under the same
  // key. Five of those records - constants, concrete, steel, timber, brickwork -
  // share the id 1 and the length 140, so neither tells them apart. The help
  // does: it writes each one's discriminator beside its key as 001/NR:1:2???,
  // an id and a band over the type that follows it, and those bands have not
  // moved since 2018. Asking for a kind and getting a material that is not of
  // that kind is then an empty part rather than the wrong bytes under the
  // right names.
  material: {
    key: "MAT",
    items: "CDB_MAT",
    itemsWhen: { field: 0, min: 0, max: 0 },
    secondary: "material",
    parts: {
      // 001/NR:1:08?? lies inside the 001/NR:1:0??? below it, so it is declared
      // first: the first kind whose condition holds takes the record.
      fluid: { record: "CDB_MAT_FLUI", when: idThenType(1, 800, 899) },
      constants: { record: "CDB_MAT_CONS", when: idThenType(1, 0, 999) },
      concrete: { record: "CDB_MAT_CONC", when: idThenType(1, 1000, 1999) },
      steel: { record: "CDB_MAT_STEE", when: idThenType(1, 2000, 2999) },
      timber: { record: "CDB_MAT_TIMB", when: idThenType(1, 3000, 3999) },
      brickwork: { record: "CDB_MAT_BRIC", when: idThenType(1, 100000, 199999) },
    },
  },
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

// Every record kind an entry names. A part is written either as the record on
// its own, where its declared id tells it apart, or as that record with the
// condition that does - so the name has to be taken out of the second form
// rather than the descriptor handed back in its place.
function recordKindsOf(definition) {
  const parts = Object.values(definition.parts || {}).map((part) =>
    typeof part === "string" ? part : part.record,
  );
  return [definition.items, definition.envelope, ...parts].filter(Boolean);
}

module.exports = { RECORDS, recordDefinition, recordKindsOf };
