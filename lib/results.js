// Mapping the result records onto something a caller can use, following what
// cdbase.chm documents for each key.

// A beam result record identifies what it belongs to through its material
// number, and the number is banded (105/LC in the help):
//
//   negative          a tendon, by its number
//   below 1024        admissible stresses for that material
//   &1024             maximum values for the solid section material
//   &2048             maximum values for tendons
//   &3072             maximum values for reinforcements
//   above             four characters: a stress point, or a shear cut when the
//                     first character is a bar
const MATERIAL_KINDS = Object.freeze([
  "tendon",
  "admissible",
  "material",
  "tendonMaximum",
  "reinforcement",
  "stressPoint",
  "shearCut",
]);

const KIND = Object.fromEntries(MATERIAL_KINDS.map((name, index) => [name, index]));

function packedName(value) {
  let name = "";
  for (let shift = 0; shift < 32; shift += 8) {
    const code = (value >>> shift) & 0xff;
    if (code === 0) break;
    name += String.fromCharCode(code);
  }
  return name.trim();
}

function materialKeyOf(mnr) {
  if (mnr < 0) return { kind: KIND.tendon, number: -mnr, name: null };
  if (mnr < 1024) return { kind: KIND.admissible, number: mnr, name: null };
  if (mnr < 2048) return { kind: KIND.material, number: mnr - 1024, name: null };
  if (mnr < 3072) return { kind: KIND.tendonMaximum, number: mnr - 2048, name: null };
  if (mnr < 4096) return { kind: KIND.reinforcement, number: mnr - 3072, name: null };
  const name = packedName(mnr);
  return name.startsWith("|")
    ? { kind: KIND.shearCut, number: 0, name: name.slice(1).trim() }
    : { kind: KIND.stressPoint, number: 0, name };
}

// Beam-like results repeat a beam over its stress points and materials, so one
// element carries many records. Splitting them out is what makes a result usable.
function mapMaterialKeys(decoded, field) {
  const source = decoded.columns[field];
  if (!source) return;
  const kinds = new Uint8Array(decoded.count);
  const numbers = new Int32Array(decoded.count);
  let names = null;
  for (let index = 0; index < decoded.count; index += 1) {
    const key = materialKeyOf(source[index]);
    kinds[index] = key.kind;
    numbers[index] = key.number;
    if (key.name) (names ||= new Array(decoded.count).fill(null))[index] = key.name;
  }
  decoded.columns.materialKind = kinds;
  decoded.columns.material = numbers;
  if (names) decoded.columns.materialName = names;
  decoded.fields.push(
    { name: "materialKind", kind: "u8", count: 1 },
    { name: "material", kind: "i32", count: 1 },
  );
  if (names) decoded.fields.push({ name: "materialName", kind: "text", count: 1 });
}

// A beam result numbered 0 continues the beam before it: the help calls it a
// jump, the two banks of a discontinuity sharing one station. Every record still
// belongs to an element, so the element number is resolved here rather than left
// for every caller to carry forward.
function mapContinuation(decoded) {
  const source = decoded.columns.nr;
  if (!source) return;
  const elements = new Int32Array(decoded.count);
  let current = 0;
  for (let index = 0; index < decoded.count; index += 1) {
    if (source[index] > 0) current = source[index];
    elements[index] = current;
  }
  decoded.columns.element = elements;
  decoded.fields.push({ name: "element", kind: "i32", count: 1 });
}

// Support reactions share the node record and are stored only where a node is
// supported or carries a residual force, so the nodes that have one are marked.
const SUPPORT_FIELDS = ["px", "py", "pz", "mx", "my", "mz", "mb"];

function mapSupports(decoded) {
  const present = SUPPORT_FIELDS.map((name) => decoded.columns[name]).filter(Boolean);
  if (!present.length) return;
  const supported = new Uint8Array(decoded.count);
  for (let index = 0; index < decoded.count; index += 1) {
    supported[index] = present.some((column) => column[index] !== 0) ? 1 : 0;
  }
  decoded.columns.supported = supported;
  decoded.fields.push({ name: "supported", kind: "u8", count: 1 });
}

// The two records a results key leads with are the maximum and the minimum of
// everything under it. They are one record each, so they are returned as plain
// objects rather than as columns of length one.
function envelopeOf(decoded) {
  if (!decoded || !decoded.count) return null;
  const rows = [];
  for (let index = 0; index < Math.min(2, decoded.count); index += 1) {
    const row = {};
    for (const field of decoded.fields) {
      const column = decoded.columns[field.name];
      row[field.name] =
        field.count === 1
          ? column[index]
          : Array.from(column.slice(index * field.count, (index + 1) * field.count));
    }
    rows.push(row);
  }
  return { max: rows[0] ?? null, min: rows[1] ?? null, record: decoded.record };
}

function mapResult(definition, decoded) {
  if (definition.continuation) mapContinuation(decoded);
  if (definition.materialKey) mapMaterialKeys(decoded, definition.materialKey);
  if (definition.supports) mapSupports(decoded);
  return decoded;
}

module.exports = { MATERIAL_KINDS, envelopeOf, mapResult, materialKeyOf, packedName };
