const { recordDefinition, VARIABLE_TAILS } = require("./records");
const { narrow, selectionsFor } = require("./record-selection");
const { recordLayoutsFor } = require("./record-layouts");
const { siblingLayouts } = require("./release-layouts");
const { envelopeOf, mapResult } = require("./results");
const { decodeKind } = require("./record-policy");

// Record layouts belong to the installation, not to the database, and are read
// the first time a database asks for a record rather than when it opens.
function layoutsFor(entry) {
  entry.layouts ||= recordLayoutsFor(entry.installRoot);
  return entry.layouts;
}

// The key a record is stored under, or why this release has none. SOFiSTiK adds
// record kinds between releases - design lines arrived after 2018 - and their
// key is declared in the headers along with them, so a release that never had
// the record has no key to name either. That is the same answer as a release
// that stores no such kind under a key it does have, and it reads the same way.
function keyFor(layouts, definition, name) {
  try {
    return layouts.key(definition.key);
  } catch (error) {
    // Only a union the headers do not declare is a release difference. A record
    // that states its own key and states it wrong is this catalog's mistake.
    if (typeof definition.key !== "string" || !(error instanceof RangeError)) throw error;
    const unavailable = new RangeError(
      `This SOFiSTiK release declares no ${definition.key} key, so "${name}" cannot be read from it.`,
      { cause: error },
    );
    unavailable.code = "ERR_CDB_RECORD_UNAVAILABLE";
    throw unavailable;
  }
}

// The releases installed beside this one, read the first time a record is found
// in a form this release does not describe, and held for the rest of the
// session.
function siblingsOf(entry) {
  entry.siblings ||= siblingLayouts(entry);
  return entry.siblings;
}

function resolveRecord(entry, name) {
  const definition = recordDefinition(name);
  const layouts = layoutsFor(entry);
  const key = keyFor(layouts, definition, name);
  const available = (kind) => Boolean(kind) && layouts.has(kind) && key.variants.includes(kind);
  if (!available(definition.items)) {
    const unavailable = new RangeError(
      `This SOFiSTiK release stores no ${definition.items} under ${key.name}, so "${name}" cannot be read from it.`,
    );
    unavailable.code = "ERR_CDB_RECORD_UNAVAILABLE";
    throw unavailable;
  }
  // CDB fills whatever buffer it is handed and refuses a record that does not
  // fit, so the read is sized by the largest kind the key can hold - every
  // variant of the union, not only the kinds this record decodes. A section key
  // carries sixty-odd kinds and a caller asks for six of them.
  const sizes = key.variants
    .filter((kind) => layouts.has(kind))
    .map((kind) => layouts.layout(kind).size);
  // Which kinds this release stores at each length. A kind told apart by its own
  // leading int owns its records whatever length they are stored at; one told
  // apart by length alone owns only a length no other kind under the key claims.
  const claims = new Map();
  for (const kind of key.variants.filter((variant) => layouts.has(variant))) {
    const size = layouts.layout(kind).size;
    claims.set(size, [...(claims.get(size) || []), kind]);
  }
  return {
    definition,
    key,
    layouts,
    claims,
    maxSize: Math.max(...sizes),
    envelope: available(definition.envelope) ? definition.envelope : null,
    parts: Object.entries(definition.parts || {})
      .map(([partName, part]) => {
        const record = typeof part === "string" ? part : part.record;
        const declared = typeof part === "string" ? null : part.when;
        const id = layouts.has(record) ? layouts.id(record) : null;
        return {
          name: partName,
          record,
          // An explicit condition wins; otherwise the kind's own declared id is
          // the discriminator, and a kind that declares none is told apart by
          // its length alone.
          when: declared ?? (id ? { field: 0, min: id, max: id } : null),
        };
      })
      .filter(({ record }) => available(record)),
    itemsWhen: definition.itemsWhen ?? null,
  };
}

function secondaryKeyFor(key, definition, secondary) {
  if (key.secondary != null) return key.secondary;
  if (!Number.isInteger(secondary)) {
    throw new RangeError(
      `Reading this record needs a ${definition.secondary || "secondary key"} number.`,
    );
  }
  return secondary;
}

// A results key leads with the maximum and the minimum of everything under it.
// The help calls them "ident 0 for maximum (first records)": they come first and
// their first int is zero. Neither shape nor length identifies them - node
// results store the envelope in a record the same size as an item - so the
// leading zero-numbered records are what is taken, at most two.
function splitEnvelope(read) {
  let leading = 0;
  let bytes = 0;
  while (leading < 2 && leading < read.lengths.length) {
    if (read.data.readInt32LE(bytes) !== 0) break;
    bytes += read.lengths[leading];
    leading += 1;
  }
  if (leading === 0) return null;
  return {
    envelope: {
      count: leading,
      lengths: read.lengths.subarray(0, leading),
      data: read.data.subarray(0, bytes),
    },
    rest: {
      count: read.lengths.length - leading,
      lengths: read.lengths.subarray(leading),
      data: read.data.subarray(bytes),
    },
  };
}

// Relates a part to the record it followed: cross-sections are stored after the
// beam they belong to, under the same key.
function ownersOf(items, parts) {
  const owners = new Int32Array(parts.count);
  let cursor = 0;
  for (let index = 0; index < parts.count; index += 1) {
    while (cursor + 1 < items.count && items.indices[cursor + 1] < parts.indices[index])
      cursor += 1;
    const owner = items.columns.element ?? items.columns.nr;
    owners[index] = items.count ? (owner?.[cursor] ?? 0) : 0;
  }
  return owners;
}

function readRecords(entry, { name, secondary, decodePolicy = "variable-tail" }) {
  const resolved = resolveRecord(entry, name);
  const secondaryKey = secondaryKeyFor(resolved.key, resolved.definition, secondary);
  const read = entry.reader.read(resolved.key.primary, secondaryKey, resolved.maxSize);

  let body = read;
  let envelope = null;
  if (resolved.envelope) {
    const split = splitEnvelope(read);
    if (split) {
      // The envelope was split off by its leading zero, so the records left are
      // its own whatever they are sized at.
      envelope = decodeKind(
        { layouts: resolved.layouts, siblings: () => siblingsOf(entry), version: entry.version },
        resolved.layouts.layout(resolved.envelope),
        split.envelope,
        {
          decodePolicy,
          variableTail: VARIABLE_TAILS[resolved.envelope],
          isolated: true,
          claims: resolved.claims,
        },
      );
      body = split.rest;
    }
  }

  const selectable = resolved.parts.filter(({ when }) => when);
  const selections = selectionsFor(body, selectable);
  const itemLayout = resolved.layouts.layout(resolved.definition.items);
  const items = decodeKind(
    { layouts: resolved.layouts, siblings: () => siblingsOf(entry), version: entry.version },
    itemLayout,
    body,
    {
      decodePolicy,
      select: narrow(selections?.items, body, resolved.itemsWhen),
      variableTail: resolved.definition.variableTail || VARIABLE_TAILS[resolved.definition.items],
      // Every kind the catalog knows has been masked out of the items, and a
      // record kind that states its own leading int has masked itself in.
      isolated: Boolean(resolved.itemsWhen),
      claims: resolved.claims,
    },
  );

  mapResult(resolved.definition, items);
  const result = {
    name,
    key: `${resolved.key.primary}/${secondaryKey}`,
    ...items,
    envelope: envelopeOf(envelope),
  };
  for (const part of resolved.parts) {
    const select = part.when ? selections.masks[selectable.indexOf(part)] : undefined;
    const decoded = mapResult(
      resolved.definition,
      decodeKind(
        { layouts: resolved.layouts, siblings: () => siblingsOf(entry), version: entry.version },
        resolved.layouts.layout(part.record),
        body,
        {
          decodePolicy,
          select,
          isolated: Boolean(part.when),
          variableTail: VARIABLE_TAILS[part.record],
          allowUnclassified: true,
          claims: resolved.claims,
        },
      ),
    );
    decoded.owners = ownersOf(items, decoded);
    result[part.name] = decoded;
  }
  return result;
}

class CdbRecordReader {
  constructor(reader, options = {}) {
    this.reader = reader;
    Object.assign(this, options);
  }

  read(payload) {
    return readRecords(this, payload);
  }

  keys(name) {
    const definition = recordDefinition(name);
    return this.reader.keys(keyFor(layoutsFor(this), definition, name).primary);
  }

  close() {
    this.reader.close();
  }
}

module.exports = { CdbRecordReader, resolveRecord, splitEnvelope };
