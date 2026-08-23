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

// SOFiSTiK's `chr` holds four ANSI characters in one int, low byte first, and a
// name longer than four is a run of them side by side - a load case's is seven
// ints and a rolled profile's designation eight. The run is one name: a zero
// byte ends it wherever it falls, so reading only the first int of a run is
// reading the first four characters of a name and calling it the name.
function packedNames(codes) {
  let name = "";
  for (const value of codes) {
    for (let shift = 0; shift < 32; shift += 8) {
      const code = (value >>> shift) & 0xff;
      if (code === 0) return name.trim();
      name += String.fromCharCode(code);
    }
  }
  return name.trim();
}

function packedName(value) {
  return packedNames([value]);
}

// SOFiSTiK stores a long string as "packed unicode": two UTF-16 code units to
// the int, the low half first, and a zero half ends it. The interface offers
// sof_lib_ps2cs for this, and reading it here instead buys three things - it is
// the one export SOFiSTiK 2018 does not have, so a release that would otherwise
// be unreadable is not; a string that fills its field to the last code has no
// terminator and comes back from the DLL empty, where the field width says
// exactly where it ends; and a code unit reaches JavaScript as itself rather
// than through a char buffer.
function packedText(codes) {
  let text = "";
  for (const code of codes) {
    const low = code & 0xffff;
    if (low === 0) break;
    text += String.fromCharCode(low);
    const high = code >>> 16;
    if (high === 0) break;
    text += String.fromCharCode(high);
  }
  return text.trimEnd();
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

// What a selective group selects, out of the run encoding SOFiSTiK writes it in.
//
// The list is a flat array of at most 255 ints and reads three ways. A positive
// number is an element, unless a negative one follows it - then the pair is the
// range between them, which the help writes as "21,-23 selects the range
// (21:23)". A zero is a lead-in and the number after it says what: a positive
// one names a whole group, -1 is every element, -30 through -33 name a
// structural point, line, area or volume the elements were derived from, and
// any other negative one is a pattern.
//
// A reference is not a number and cannot be flattened into one - which group,
// or which structural line, is a question only the rest of the database can
// answer - so the two come back apart.
const DERIVED_FROM = new Map([
  [-30, "point"],
  [-31, "line"],
  [-32, "area"],
  [-33, "volume"],
]);

function secondaryGroupSelection(numbers) {
  const ranges = [];
  const references = [];
  const values = Array.from(numbers || []);
  let index = 0;
  while (index < values.length) {
    const value = values[index];
    const next = index + 1 < values.length ? values[index + 1] : 0;
    if (value === 0) {
      // A zero with nothing meaningful behind it is the padding the record was
      // written short of, not a selection of group zero.
      if (next === 0) break;
      if (next > 0) {
        references.push({ kind: "group", number: next });
        index += 2;
      } else if (next === -1) {
        references.push({ kind: "all" });
        index += 2;
      } else if (DERIVED_FROM.has(next)) {
        references.push({ kind: DERIVED_FROM.get(next), number: values[index + 2] });
        index += 3;
      } else {
        references.push({ kind: "pattern", number: -next });
        index += 2;
      }
      continue;
    }
    if (value < 0) {
      // An end with no start before it. Nothing sensible selects that.
      index += 1;
      continue;
    }
    if (next < 0 && !DERIVED_FROM.has(next) && next !== -1) {
      ranges.push([value, -next]);
      index += 2;
    } else {
      ranges.push([value, value]);
      index += 1;
    }
  }
  return { ranges, references };
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

module.exports = {
  MATERIAL_KINDS,
  envelopeOf,
  mapResult,
  materialKeyOf,
  packedName,
  packedNames,
  secondaryGroupSelection,
  packedText,
};
