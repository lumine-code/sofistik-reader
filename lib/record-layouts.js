const fs = require("node:fs");
const path = require("node:path");

// Every leaf type the CDB record headers use. SOFiSTiK typedefs `bhr` to int,
// `pckcode` to the packed text the interface unpacks through sof_lib_ps2cs, and
// `chr` to the four ANSI characters a name is stored in - an action type, a
// stress point - which is why those are read as characters and not as numbers.
const LEAF_TYPES = Object.freeze({
  int: { size: 4, kind: "i32" },
  "unsigned int": { size: 4, kind: "u32" },
  short: { size: 2, kind: "i16" },
  char: { size: 1, kind: "i8" },
  float: { size: 4, kind: "f32" },
  double: { size: 8, kind: "f64" },
  CDB_INT: { size: 4, kind: "i32" },
  chr: { size: 4, kind: "chars" },
  bhr: { size: 4, kind: "i32" },
  pckcode: { size: 4, kind: "text" },
});

const HEADER_FILES = /^cdbtype.*\.h$/;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const STRUCT = /typedef\s+struct\s+tag(\w+)\s*\{([\s\S]*?)\}\s*type\1\s*;/g;
const UNION = /typedef\s+union\s+tagu(\w+)\s*\{([\s\S]*?)\}\s*typeu\1\s*;/g;
// A member is either a plain declaration or an anonymous struct declared in
// place - `struct { float m_sigx; ... } m_sg[4];` - which several result records
// use for their Gauss points.
const MEMBER =
  /struct\s*\{([^{}]*)\}\s*(\w+)((?:\[\d+\])*)\s*;|^[ \t]*(unsigned\s+int|\w+)[ \t]+(\w+)((?:\[\d+\])*)[ \t]*;/gm;
const MACRO = /#define\s+(\w+)_(KWH|KWL|VER|ID)\s+(-?\d+)/g;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readHeaderSources(directory, io) {
  const names = io.readdir(directory).filter((name) => HEADER_FILES.test(name));
  if (!names.length) {
    throw new Error(`No SOFiSTiK CDB record headers were found in ${directory}.`);
  }
  return names.map((name) => io.readFile(path.join(directory, name)));
}

function dimensionsOf(text) {
  return [...(text || "").matchAll(/\[(\d+)\]/g)].map(([, size]) => Number(size));
}

function collectMembers(body) {
  const members = [];
  for (const match of body.matchAll(MEMBER)) {
    const [, inlineBody, inlineName, inlineDimensions, type, name, dimensions] = match;
    if (inlineBody !== undefined) {
      members.push({
        name: inlineName.replace(/^m_/, ""),
        members: collectMembers(inlineBody),
        dimensions: dimensionsOf(inlineDimensions),
      });
    } else {
      members.push({
        name: name.replace(/^m_/, ""),
        type,
        dimensions: dimensionsOf(dimensions),
      });
    }
  }
  return members;
}

// Reads every record definition out of one installation's headers. The result is
// raw structure: offsets are computed on demand, because a database touches a
// handful of the seven hundred records a release defines.
function readDefinitions(directory, io) {
  const structures = new Map();
  const unions = new Map();
  const macros = new Map();
  for (const source of readHeaderSources(directory, io)) {
    const text = source.replace(BLOCK_COMMENT, " ");
    for (const [, name, body] of text.matchAll(STRUCT)) {
      structures.set(name, collectMembers(body));
    }
    for (const [, name, body] of text.matchAll(UNION)) {
      const variants = collectMembers(body)
        .filter(({ type }) => type.startsWith("type"))
        .map(({ type }) => type.replace(/^type/, ""));
      unions.set(name, variants);
    }
    for (const [, name, macro, value] of text.matchAll(MACRO)) {
      macros.set(name, { ...macros.get(name), [macro]: Number(value) });
    }
  }
  return { structures, unions, macros };
}

// A nested member is declared with the typedef name, `typeCDB_INNER`, while the
// definition is stored under its tag, `CDB_INNER`.
// MSVC lays records out with natural alignment: everything is four bytes except
// double, so eight-byte alignment is the only padding case.
function structureNameOf(type) {
  return type.replace(/^type/, "");
}

function alignmentOf(member, definitions, seen) {
  if (member.members) return layoutForMembers(member.members, definitions, seen).alignment;
  const leaf = LEAF_TYPES[member.type];
  if (leaf) return leaf.size;
  return layoutOf(structureNameOf(member.type), definitions, seen).alignment;
}

function alignTo(offset, alignment) {
  const remainder = offset % alignment;
  return remainder === 0 ? offset : offset + alignment - remainder;
}

function layoutOf(recordName, definitions, seen = new Set()) {
  const cached = definitions.layouts.get(recordName);
  if (cached) return cached;
  const members = definitions.structures.get(recordName);
  if (!members) throw new RangeError(`The SOFiSTiK CDB record ${recordName} is not defined.`);
  if (seen.has(recordName)) {
    throw new RangeError(`The SOFiSTiK CDB record ${recordName} contains itself.`);
  }
  const layout = {
    name: recordName,
    ...layoutForMembers(members, definitions, new Set([...seen, recordName])),
  };
  definitions.layouts.set(recordName, layout);
  return layout;
}

function layoutForMembers(members, definitions, nested) {
  const fields = [];
  let offset = 0;
  let alignment = 1;
  for (const member of members) {
    const count = member.dimensions.reduce((total, size) => total * size, 1);
    const leaf = member.members ? null : LEAF_TYPES[member.type];
    const memberAlignment = alignmentOf(member, definitions, nested);
    alignment = Math.max(alignment, memberAlignment);
    offset = alignTo(offset, memberAlignment);
    if (leaf) {
      fields.push({
        name: member.name,
        kind: leaf.kind,
        offset,
        size: leaf.size,
        count,
        dimensions: member.dimensions,
      });
      offset += leaf.size * count;
      continue;
    }
    // A nested record - declared in place or by name - contributes its own
    // fields, prefixed with the member name, so a decoded record is always flat.
    const inner = member.members
      ? layoutForMembers(member.members, definitions, nested)
      : layoutOf(structureNameOf(member.type), definitions, nested);
    for (let index = 0; index < count; index += 1) {
      const base = offset + index * inner.size;
      const prefix = count === 1 ? member.name : `${member.name}${index}`;
      for (const field of inner.fields) {
        fields.push({ ...field, name: `${prefix}_${field.name}`, offset: base + field.offset });
      }
    }
    offset += inner.size * count;
  }

  return { fields, size: alignTo(offset, alignment), alignment };
}

class RecordLayouts {
  constructor(directory, definitions) {
    this.directory = directory;
    this.definitions = { ...definitions, layouts: new Map() };
  }

  // The union that shares a key names every record kind stored under it, so the
  // key and the variants are read from the headers rather than declared here.
  // A record states its key by naming the union SOFiSTiK groups its kinds
  // under, which is where the key numbers are declared. Not every record has
  // one: the headers carry a struct for each, but a union only for those the
  // interface groups, and a kinematic constraint has the struct and no union to
  // read a key from. Such a record states its key itself, and its own kind is
  // then the only one stored under it.
  key(unionName) {
    if (isObject(unionName)) {
      if (!Number.isInteger(unionName.primary) || !unionName.variants?.length) {
        throw new RangeError("A stated SOFiSTiK CDB key needs a primary number and its kinds.");
      }
      return {
        name: unionName.variants[0],
        primary: unionName.primary,
        secondary: Number.isInteger(unionName.secondary) ? unionName.secondary : null,
        variants: [...unionName.variants],
      };
    }
    const variants = this.definitions.unions.get(unionName);
    if (!variants) throw new RangeError(`The SOFiSTiK CDB key ${unionName} is not defined.`);
    const macros = this.definitions.macros.get(unionName) || {};
    if (macros.KWH == null) {
      throw new RangeError(`The SOFiSTiK CDB key ${unionName} declares no primary key.`);
    }
    return { name: unionName, primary: macros.KWH, secondary: macros.KWL ?? null, variants };
  }

  layout(recordName) {
    return layoutOf(recordName, this.definitions);
  }

  // Several record kinds sharing a key each declare the value their leading int
  // holds - a section's rectangle is 10, its polygon points 101 - which is how
  // the kinds are told apart where their lengths collide.
  id(recordName) {
    const macros = this.definitions.macros.get(recordName.replace(/^CDB_/, ""));
    return macros?.ID ?? null;
  }

  has(recordName) {
    return this.definitions.structures.has(recordName);
  }

  get size() {
    return this.definitions.structures.size;
  }
}

const cache = new Map();

// One installation's headers are read once per process: the layouts belong to
// the release, not to a database, so every database opened against the same
// installation shares them.
function recordLayoutsFor(installRoot, options = {}) {
  const directory =
    options.headerDirectory || path.join(installRoot, "interfaces", "examples", "c++");
  const cached = cache.get(directory);
  if (cached) return cached;
  const io = {
    readdir: options.readdir || ((target) => fs.readdirSync(target)),
    readFile: options.readFile || ((file) => fs.readFileSync(file, "latin1")),
  };
  const layouts = new RecordLayouts(directory, readDefinitions(directory, io));
  cache.set(directory, layouts);
  return layouts;
}

function clearRecordLayoutCache() {
  cache.clear();
}

module.exports = { LEAF_TYPES, RecordLayouts, clearRecordLayoutCache, recordLayoutsFor };
