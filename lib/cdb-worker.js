const path = require("node:path");
const { decodeMerged, decodeRecords } = require("./record-decoder");
const { recordDefinition } = require("./records");
const { narrow, selectionsFor } = require("./record-selection");
const { recordLayoutsFor } = require("./record-layouts");
const { layoutDescribing, siblingLayouts } = require("./release-layouts");
const { envelopeOf, mapResult, packedName, packedText } = require("./results");

const readers = new Map();
let nextReaderId = 1;

function createReader(options) {
  const interfaceDirectory = path.dirname(options.dllPath);
  const searchDirectories = [interfaceDirectory, options.installRoot];
  process.env.PATH = `${searchDirectories.join(path.delimiter)}${path.delimiter}${process.env.PATH || ""}`;
  const { CdbReader } = require("./native-addon").loadNativeAddon();
  const reader = new CdbReader(options.databasePath, options.dllPath);
  const readerId = nextReaderId++;
  readers.set(readerId, {
    reader,
    environmentRoot: options.environmentRoot,
    installRoot: options.installRoot,
    version: options.version,
  });
  return readerId;
}

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
    throw new RangeError(
      `This SOFiSTiK release declares no ${definition.key} key, so "${name}" cannot be read from it.`,
      { cause: error },
    );
  }
}

// The releases installed beside this one, read the first time a record is found
// in a form this release does not describe, and held for the rest of the
// session.
function siblingsOf(entry) {
  entry.siblings ||= siblingLayouts(entry);
  return entry.siblings;
}

// The layout that describes a record at the length this database stores it in,
// which is this installation's own whenever it fits and a sibling release's when
// it does not.
function layoutForStoredLength(entry, recordName, storedLength) {
  return layoutDescribing(
    { layouts: layoutsFor(entry), siblings: siblingsOf(entry), version: entry.version },
    recordName,
    storedLength,
  );
}

function resolveRecord(entry, name) {
  const definition = recordDefinition(name);
  const layouts = layoutsFor(entry);
  const key = keyFor(layouts, definition, name);
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

function decodeText(decoded) {
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
      strings[index] = packedText(codes.subarray(index * field.count, (index + 1) * field.count));
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

// A record kind is only decoded when its stored length matches a layout that
// describes it. When neither this installation nor a release installed beside it
// does, the release that wrote the database is not on this machine - say so,
// naming the lengths, rather than decoding whatever the bytes happen to be.
function refuseVersionMismatch(entry, resolved, layout, items, secondaryKey) {
  if (items.count || !items.skipped.length) return;
  const stored = entry.reader.version(resolved.key.primary, secondaryKey);
  const lengths = items.skipped
    .map(({ length, count }) => `${count} of ${length} bytes`)
    .join(", ");
  const beside = siblingsOf(entry).map(({ version }) => version);
  throw new Error(
    `CDB ${resolved.key.primary}/${secondaryKey} holds ${lengths}, but this installation describes ` +
      `${layout.name} as ${layout.size} bytes` +
      (stored ? ` (the database stores record version ${stored})` : "") +
      ". The database was written by a release that stored a different version of this record" +
      (beside.length
        ? `, and none of the releases installed beside it (${beside.join(", ")}) describes that length`
        : "") +
      ".",
  );
}

// The stored lengths this decode could still be about: a length the read holds
// that this kind is entitled to. A kind told apart by its own leading int has
// already had every other kind masked out of its selection, so every length left
// is its own. A kind told apart by length alone is only entitled to a length no
// other kind under the key is stored at.
function candidateLengths(decoded, { isolated, claims, name }) {
  return decoded.skipped
    .filter(
      ({ length }) => isolated || (claims.get(length) || [name]).every((kind) => kind === name),
    )
    .map(({ length }) => length);
}

// Decodes one record kind out of a read.
//
// The length CDB stores a record at is the layout it was written with, and the
// installed release is not always the one that wrote it: a database from a newer
// release holds a longer record than these headers describe, one from an older
// release a shorter or a differently ordered one. Where a release installed
// beside this one describes the record at exactly the stored length, that layout
// is used and the decode is as exact as a version-matched read - the fields come
// from headers SOFiSTiK published for that form, not from an assumption about
// where they sit.
//
// `partial` remains the last resort, and it is a guess: it keeps the fields of
// this installation's layout that fit inside the stored record, which is right
// only where the older form was a prefix of the newer one. SOFiSTiK has both
// appended to a record and inserted into the middle of one, so the result says
// the placement was assumed rather than described.
//
// A kind stored in more than one form is merged only where the catalog says so,
// because merging every length under a key would swallow the other kinds stored
// there.
function decodeKind(entry, layout, read, { partial, select, merge, isolated, claims } = {}) {
  if (merge && partial) return decodeText(decodeMerged(layout, read, { select }));
  const decoded = decodeRecords(layout, read, { select });
  if (decoded.count) return decodeText(decoded);

  const candidates = claims
    ? candidateLengths(decoded, { isolated, claims, name: layout.name })
    : [];
  for (const length of candidates) {
    const found = layoutForStoredLength(entry, layout.name, length);
    if (found.ambiguous) {
      throw new Error(
        `CDB holds ${layout.name} at ${length} bytes, and the releases installed beside this one ` +
          `describe that length two different ways (${found.ambiguous
            .map((releases) => releases.join(", "))
            .join("; ")}), so which one ` +
          "wrote it cannot be told.",
      );
    }
    if (!found.layout) continue;
    const described = decodeText(decodeRecords(found.layout, read, { select }));
    if (!described.count) continue;
    // Which release describes the form the database holds, so a caller reading
    // an unexpected field list can see where it came from.
    described.describedBy = {
      version: found.version,
      length,
      ...(found.alsoDescribedBy?.length ? { alsoDescribedBy: found.alsoDescribedBy } : {}),
    };
    return described;
  }

  if (!partial) return decodeText(decoded);
  const shorter = decoded.skipped.filter(({ length }) => length < layout.size);
  if (shorter.length !== 1) return decodeText(decoded);
  const assumed = decodeText(
    decodeRecords(layout, read, { select, storedLength: shorter[0].length }),
  );
  if (assumed.partial) assumed.partial.assumed = true;
  return assumed;
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
      // The envelope was split off by its leading zero, so the records left are
      // its own whatever they are sized at.
      envelope = decodeKind(entry, resolved.layouts.layout(resolved.envelope), split.envelope, {
        partial,
        isolated: true,
        claims: resolved.claims,
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
    // Every kind the catalog knows has been masked out of the items, and a
    // record kind that states its own leading int has masked itself in.
    isolated: Boolean(resolved.itemsWhen),
    claims: resolved.claims,
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
      decodeKind(entry, resolved.layouts.layout(part.record), body, {
        partial,
        select,
        isolated: Boolean(part.when),
        claims: resolved.claims,
      }),
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
    return entry.reader.keys(keyFor(layouts, definition, payload.name).primary);
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
