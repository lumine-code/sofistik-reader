// Turns one CDB read - a flat buffer of records plus the length CDB reported for
// each - into columns, one typed array per field. Columns are the cheap shape:
// a read of 200k quads costs one allocation per field and no objects at all, and
// the arrays are what a renderer or an analysis wants anyway. Objects are built
// on request, for the small reads where they are convenient.

const COLUMN_TYPES = Object.freeze({
  i32: Int32Array,
  u32: Uint32Array,
  i16: Int16Array,
  i8: Int8Array,
  f32: Float32Array,
  f64: Float64Array,
  text: Uint32Array,
  chars: Uint32Array,
});

const READERS = Object.freeze({
  i32: "getInt32",
  u32: "getUint32",
  i16: "getInt16",
  i8: "getInt8",
  f32: "getFloat32",
  f64: "getFloat64",
  text: "getUint32",
  chars: "getUint32",
});

function columnFor(field, count) {
  const Type = COLUMN_TYPES[field.kind];
  if (!Type) throw new RangeError(`Unsupported CDB field type: ${field.kind}`);
  return new Type(count * field.count);
}

// Records of one length sit at a fixed stride, so a four-byte field can be read
// through a typed array view instead of a DataView. That is the difference
// between one bounds-checked call per value and a strided copy.
function gatherAligned(column, buffer, offsets, field, stride) {
  const View = COLUMN_TYPES[field.kind];
  const source = new View(buffer.buffer, buffer.byteOffset, buffer.byteLength / field.size);
  const step = field.offset / field.size;
  const width = field.count;
  for (let record = 0; record < offsets.length; record += 1) {
    const base = offsets[record] / field.size + step;
    const target = record * width;
    for (let element = 0; element < width; element += 1) {
      column[target + element] = source[base + element];
    }
  }
  return stride;
}

function gatherUnaligned(column, buffer, offsets, field) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const read = READERS[field.kind];
  const width = field.count;
  for (let record = 0; record < offsets.length; record += 1) {
    const base = offsets[record] + field.offset;
    const target = record * width;
    for (let element = 0; element < width; element += 1) {
      column[target + element] = view[read](base + element * field.size, true);
    }
  }
}

// Where each record starts, and which ones this layout can decode. CDB stores
// several record kinds under one key - a results key leads with two envelope
// records of a different shape - and they are told apart by their length.
function offsetsFor(read, size, select) {
  const offsets = [];
  const indices = [];
  const other = new Map();
  let position = 0;
  for (let index = 0; index < read.lengths.length; index += 1) {
    const length = read.lengths[index];
    if (!select || select[index]) {
      if (length === size) {
        offsets.push(position);
        indices.push(index);
      } else other.set(length, (other.get(length) || 0) + 1);
    }
    position += length;
  }
  return { offsets, indices, other };
}

// The fields of a layout that a record of this length actually holds.
//
// A record ends wherever CDB stopped writing it, and that is not always at a
// field boundary: an array is written to whatever length it was filled to, so a
// field can begin inside the record and run past its end. The elements that are
// there are as real as any other, so such a field is kept with the number of
// them the record reaches rather than thrown away whole - a thermal eigenstress
// record declared with 256 temperatures and stored with six is six
// temperatures, not none.
//
// A field that does not begin at all is a different thing and is reported as a
// different thing.
function fieldsWithin(layout, size) {
  const kept = [];
  const dropped = [];
  const shortened = [];
  for (const field of layout.fields) {
    if (field.offset + field.size * field.count <= size) {
      kept.push(field);
      continue;
    }
    const elements = Math.floor((size - field.offset) / field.size);
    if (elements <= 0) {
      dropped.push(field.name);
      continue;
    }
    // The layout belongs to the installation and is shared by every read of it,
    // so the shortened field is a copy.
    kept.push({ ...field, count: elements });
    shortened.push({ name: field.name, count: elements, of: field.count });
  }
  return { kept, dropped, shortened };
}

// `storedLength` decodes records shorter than the layout: an older release
// stored fewer fields, or CDB wrote a trailing array only as far as it was
// filled. What was dropped and what was cut short are both reported, never
// guessed at.
// `select` is a mask over the records of the read, for the keys whose record
// kinds are told apart by their contents rather than by their length.
function decodeRecords(layout, read, { storedLength, select } = {}) {
  const size = storedLength || layout.size;
  const { kept, dropped, shortened } = fieldsWithin(layout, size);
  const { offsets, indices, other } = offsetsFor(read, size, select);
  const buffer = read.data;
  const columns = {};
  const aligned = size % 4 === 0;
  for (const field of kept) {
    const column = columnFor(field, offsets.length);
    if (offsets.length === 0) {
      columns[field.name] = column;
      continue;
    }
    if (
      aligned &&
      field.size >= 4 &&
      field.offset % field.size === 0 &&
      buffer.byteOffset % field.size === 0 &&
      buffer.byteLength % field.size === 0 &&
      offsets.every((offset) => offset % field.size === 0)
    ) {
      gatherAligned(column, buffer, offsets, field, size);
    } else {
      gatherUnaligned(column, buffer, offsets, field);
    }
    columns[field.name] = column;
  }
  return {
    record: layout.name,
    count: offsets.length,
    recordLength: size,
    // The quantity a field holds travels with it: a caller converting a
    // database out of SOFiSTiK's unit set reads the code rather than the name,
    // and the name is all it would otherwise have.
    fields: kept.map(({ name, kind, count, unit }) => ({
      name,
      kind,
      count,
      ...(unit == null ? {} : { unit }),
    })),
    // Present only when the database stores a shorter record than this
    // installation describes.
    partial:
      size === layout.size
        ? null
        : {
            storedLength: size,
            layoutLength: layout.size,
            dropped,
            // The fields the record begins and does not finish, with how many of
            // their elements it holds.
            ...(shortened.length ? { shortened } : {}),
          },
    columns,
    // Where each decoded record sat in the key, which is what relates a record
    // to the one it followed - a beam's cross-sections follow their beam.
    indices: Int32Array.from(indices),
    skipped: [...other].map(([length, count]) => ({ length, count })),
  };
}

// One record kind can be stored in more than one length: a node result carries
// its support reactions only where the node is supported, so an unsupported node
// is a shorter record of the same kind. Each stored length is decoded with the
// fields that fit and the groups are merged back into record order, so a caller
// sees one set of columns - fields absent from a shorter record read as zero,
// which is what CDB means by not storing them.
function decodeMerged(layout, read, { select } = {}) {
  const lengths = new Set();
  for (let index = 0; index < read.lengths.length; index += 1) {
    if (select && !select[index]) continue;
    if (read.lengths[index] <= layout.size) lengths.add(read.lengths[index]);
  }
  if (lengths.size <= 1) {
    return decodeRecords(layout, read, { select, storedLength: lengths.values().next().value });
  }

  // Widest first, so its fields are the ones a caller sees.
  const groups = [...lengths]
    .sort((left, right) => right - left)
    .map((storedLength) => decodeRecords(layout, read, { select, storedLength }));
  const count = groups.reduce((total, group) => total + group.count, 0);
  const widest = groups[0];

  const groupOf = new Int32Array(count);
  const slotOf = new Int32Array(count);
  const recordOf = new Int32Array(count);
  let flat = 0;
  groups.forEach((group, index) => {
    for (let slot = 0; slot < group.count; slot += 1) {
      groupOf[flat] = index;
      slotOf[flat] = slot;
      recordOf[flat] = group.indices[slot];
      flat += 1;
    }
  });
  // CDB's own order is what parts and continuations depend on.
  const order = Array.from({ length: count }, (unused, index) => index).sort(
    (left, right) => recordOf[left] - recordOf[right],
  );

  const columns = {};
  // The widest form decides the shape of every column, and a form that holds
  // fewer elements of a field writes the ones it has into the front of its slot.
  // The two strides differ, which is why each is named.
  const width = new Map(widest.fields.map(({ name, count: elements }) => [name, elements]));
  for (const field of widest.fields) columns[field.name] = columnFor(field, count);
  const indices = new Int32Array(count);
  const recordLengths = new Int32Array(count);
  for (let target = 0; target < count; target += 1) {
    const source = order[target];
    const group = groups[groupOf[source]];
    const slot = slotOf[source];
    indices[target] = recordOf[source];
    recordLengths[target] = group.recordLength;
    for (const field of group.fields) {
      const into = columns[field.name];
      if (!into) continue;
      const stride = width.get(field.name);
      const from = group.columns[field.name];
      const elements = Math.min(field.count, stride);
      for (let element = 0; element < elements; element += 1) {
        into[target * stride + element] = from[slot * field.count + element];
      }
    }
  }

  return {
    record: layout.name,
    count,
    recordLength: widest.recordLength,
    // One record kind, several stored forms: which form each record was, and how
    // many of each.
    recordLengths,
    stored: groups.map((group) => ({ length: group.recordLength, count: group.count })),
    fields: widest.fields,
    partial: widest.partial,
    columns,
    indices,
    skipped: groups[0].skipped.filter(({ length }) => !lengths.has(length)),
  };
}

// The convenience shape: one plain object per record, array-valued where a field
// is an array. Never used internally, so a large read never pays for it.
function toObjects(decoded) {
  const results = new Array(decoded.count);
  for (let index = 0; index < decoded.count; index += 1) {
    const record = {};
    for (const field of decoded.fields) {
      const column = decoded.columns[field.name];
      if (field.count === 1) {
        record[field.name] = column[index];
      } else {
        const from = index * field.count;
        record[field.name] = Array.from(column.slice(from, from + field.count));
      }
    }
    results[index] = record;
  }
  return results;
}

module.exports = { COLUMN_TYPES, decodeMerged, decodeRecords, toObjects };
