const path = require("node:path");
const { decodeMerged, decodeRecords } = require("./record-decoder");
const { recordDefinition } = require("./records");
const { recordLayoutsFor } = require("./record-layouts");
const { envelopeOf, mapResult, packedName } = require("./results");

const readers = new Map();
let nextReaderId = 1;

function createReader(options) {
  const interfaceDirectory = path.dirname(options.dllPath);
  const searchDirectories = [interfaceDirectory, options.installRoot];
  process.env.PATH = `${searchDirectories.join(path.delimiter)}${path.delimiter}${process.env.PATH || ""}`;
  const { CdbReader } = require("./native-addon").loadNativeAddon();
  const reader = new CdbReader(options.databasePath, options.dllPath);
  const readerId = nextReaderId++;
  readers.set(readerId, { reader, installRoot: options.installRoot });
  return readerId;
}

// Record layouts belong to the installation, not to the database, and are read
// the first time a database asks for a record rather than when it opens.
function layoutsFor(entry) {
  entry.layouts ||= recordLayoutsFor(entry.installRoot);
  return entry.layouts;
}

function resolveRecord(entry, name) {
  const definition = recordDefinition(name);
  const layouts = layoutsFor(entry);
  const key = layouts.key(definition.key);
  const available = (kind) => Boolean(kind) && layouts.has(kind) && key.variants.includes(kind);
  if (!available(definition.items)) {
    throw new RangeError(
      `This SOFiSTiK release stores no ${definition.items} under ${key.name}, so "${name}" cannot be read from it.`,
    );
  }
  // CDB fills whatever buffer it is handed and refuses a record that does not
  // fit, so the read is sized by the largest kind the key can hold - every
  // variant of the union, not only the kinds this record decodes. A section key
  // carries sixty-odd kinds and a caller asks for six of them.
  const sizes = key.variants
    .filter((kind) => layouts.has(kind))
    .map((kind) => layouts.layout(kind).size);
  return {
    definition,
    key,
    layouts,
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
    merge: Boolean(definition.merge),
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

function decodeText(entry, decoded) {
  for (const field of decoded.fields) {
    // A chr field is four ANSI characters in one int, unpacked here rather than
    // handed to a caller as a number that means nothing.
    if (field.kind === "chars") {
      const codes = decoded.columns[field.name];
      const names = new Array(decoded.count);
      for (let index = 0; index < decoded.count; index += 1) {
        names[index] = packedName(codes[index]);
      }
      decoded.columns[field.name] = names;
      continue;
    }
    if (field.kind !== "text") continue;
    const codes = decoded.columns[field.name];
    const strings = new Array(decoded.count);
    for (let index = 0; index < decoded.count; index += 1) {
      strings[index] = entry.reader.text(
        codes.subarray(index * field.count, (index + 1) * field.count),
      );
    }
    decoded.columns[field.name] = strings;
    // A run of packed codes decodes to one string per record, not one per code.
    field.count = 1;
  }
  return decoded;
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

// A record kind is only decoded when its stored length matches the layout the
// installed headers describe. When nothing matches, the database was written by
// a release that stored a different version of the record - say so, naming both
// versions, rather than decoding whatever the bytes happen to be.
function refuseVersionMismatch(entry, resolved, layout, items, secondaryKey) {
  if (items.count || !items.skipped.length) return;
  const stored = entry.reader.version(resolved.key.primary, secondaryKey);
  const lengths = items.skipped
    .map(({ length, count }) => `${count} of ${length} bytes`)
    .join(", ");
  throw new Error(
    `CDB ${resolved.key.primary}/${secondaryKey} holds ${lengths}, but this installation describes ` +
      `${layout.name} as ${layout.size} bytes` +
      (stored ? ` (the database stores record version ${stored})` : "") +
      ". The database was written by a release that stored a different version of this record.",
  );
}

// Decodes one record kind out of a read. When the database stores a shorter
// record than the installed headers describe, nothing matches; the caller may
// then ask for the fields that do fit, which is only unambiguous when a single
// shorter length is present. A longer stored record is never truncated to fit.
// A kind stored in more than one form is merged only where the catalog says so,
// because merging every length under a key would swallow the other kinds stored
// there. Everything else decodes at its own length, falling back to the one
// shorter form an older database may hold.
function decodeKind(entry, layout, read, { partial, select, merge } = {}) {
  if (merge && partial) return decodeText(entry, decodeMerged(layout, read, { select }));
  const decoded = decodeRecords(layout, read, { select });
  if (decoded.count || !partial) return decodeText(entry, decoded);
  const shorter = decoded.skipped.filter(({ length }) => length < layout.size);
  if (shorter.length !== 1) return decodeText(entry, decoded);
  return decodeText(
    entry,
    decodeRecords(layout, read, { select, storedLength: shorter[0].length }),
  );
}

// Records a kind's own condition rejects are not that kind.
function narrow(mask, read, condition) {
  if (!condition) return mask;
  const narrowed = mask ? Uint8Array.from(mask) : new Uint8Array(read.lengths.length).fill(1);
  let position = 0;
  for (let index = 0; index < read.lengths.length; index += 1) {
    const length = read.lengths[index];
    const value =
      length >= (condition.field ?? 0) * 4 + 4
        ? read.data.readInt32LE(position + (condition.field ?? 0) * 4)
        : 0;
    if (
      (condition.min != null && value < condition.min) ||
      (condition.max != null && value > condition.max)
    ) {
      narrowed[index] = 0;
    }
    position += length;
  }
  return narrowed;
}

// Several record kinds share a key and are told apart by their leading ints, not
// by their length: beam stresses store tendon stresses under a negative second
// int and thermal eigenstresses under a second int above 100000, exactly as the
// help writes them (105/LC:+:-, 105/LC:+:1?????). Reading two ints per record is
// what makes those kinds separable even when an older database stores them in a
// shorter form than the installed headers describe.
function selectionsFor(read, variants) {
  if (!variants.length) return null;
  const masks = variants.map(() => new Uint8Array(read.lengths.length));
  const items = new Uint8Array(read.lengths.length).fill(1);
  let position = 0;
  for (let index = 0; index < read.lengths.length; index += 1) {
    const length = read.lengths[index];
    const words = [
      length >= 4 ? read.data.readInt32LE(position) : 0,
      length >= 8 ? read.data.readInt32LE(position + 4) : 0,
    ];
    variants.forEach(({ when }, variant) => {
      const value = words[when.field ?? 0];
      const matches =
        (when.min == null || value >= when.min) && (when.max == null || value <= when.max);
      if (matches && items[index]) {
        masks[variant][index] = 1;
        items[index] = 0;
      }
    });
    position += length;
  }
  return { masks, items };
}

function readRecords(entry, { name, secondary, partial }) {
  const resolved = resolveRecord(entry, name);
  const secondaryKey = secondaryKeyFor(resolved.key, resolved.definition, secondary);
  const read = entry.reader.read(resolved.key.primary, secondaryKey, resolved.maxSize);

  let body = read;
  let envelope = null;
  if (resolved.envelope) {
    const split = splitEnvelope(read);
    if (split) {
      envelope = decodeKind(entry, resolved.layouts.layout(resolved.envelope), split.envelope, {
        partial,
      });
      body = split.rest;
    }
  }

  const selectable = resolved.parts.filter(({ when }) => when);
  const selections = selectionsFor(body, selectable);
  const itemLayout = resolved.layouts.layout(resolved.definition.items);
  const items = decodeKind(entry, itemLayout, body, {
    partial,
    select: narrow(selections?.items, body, resolved.itemsWhen),
    merge: resolved.merge,
  });
  refuseVersionMismatch(entry, resolved, itemLayout, items, secondaryKey);
  mapResult(resolved.definition, items);
  const result = {
    name,
    key: `${resolved.key.primary}/${secondaryKey}`,
    ...items,
    envelope: envelopeOf(envelope),
  };
  for (const [index, part] of resolved.parts.entries()) {
    const select = part.when ? selections.masks[selectable.indexOf(part)] : undefined;
    const decoded = mapResult(
      resolved.definition,
      decodeKind(entry, resolved.layouts.layout(part.record), body, { partial, select }),
    );
    decoded.owners = ownersOf(items, decoded);
    result[part.name] = decoded;
    void index;
  }
  return result;
}

function dispatch(message) {
  const { operation, readerId, payload } = message;
  if (operation === "open") return createReader(payload);
  const entry = readers.get(readerId);
  if (!entry) throw new Error("The SOFiSTiK CDB reader is closed.");
  if (operation === "records") return readRecords(entry, payload);
  if (operation === "keys") {
    const layouts = layoutsFor(entry);
    const definition = recordDefinition(payload.name);
    return entry.reader.keys(layouts.key(definition.key).primary);
  }
  if (operation === "close") {
    entry.reader.close();
    readers.delete(readerId);
    return true;
  }
  throw new RangeError(`Unknown SOFiSTiK worker operation: ${operation}`);
}

process.on("message", (message) => {
  const { id } = message;
  try {
    process.send({ id, value: dispatch(message) });
  } catch (error) {
    process.send({
      id,
      error: { name: error?.name || "Error", message: error?.message || String(error) },
    });
  }
});

function closeAll() {
  for (const { reader } of readers.values()) reader.close();
  readers.clear();
}

process.on("disconnect", closeAll);
process.on("exit", closeAll);
