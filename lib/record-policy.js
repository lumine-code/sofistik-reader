const { decodeRecords, COLUMN_TYPES } = require("./record-decoder");
const { layoutDescribing } = require("./release-layouts");
const { packedNames, packedText } = require("./results");

const DECODE_POLICIES = Object.freeze(["exact", "variable-tail", "assumed-prefix"]);

function validateDecodePolicy(policy = "variable-tail") {
  if (!DECODE_POLICIES.includes(policy)) {
    throw new RangeError(`Unknown CDB decode policy: ${policy}.`);
  }
  return policy;
}

function decodeText(decoded) {
  for (const field of decoded.fields) {
    const unpack = field.kind === "chars" ? packedNames : field.kind === "text" ? packedText : null;
    if (!unpack) continue;
    const codes = decoded.columns[field.name];
    decoded.columns[field.name] = Array.from({ length: decoded.count }, (_, index) =>
      unpack(codes.subarray(index * field.count, (index + 1) * field.count)),
    );
    field.count = 1;
  }
  return decoded;
}

function knownTail(layout, length, tail) {
  if (Array.isArray(tail)) return tail.some((form) => knownTail(layout, length, form));
  if (!tail || length >= layout.size) return false;
  const field = layout.fields.find(({ name }) => name === (tail.before || tail.after));
  if (!field) return false;
  const boundary = field.offset + (tail.after ? field.size * field.count : 0);
  return tail.onlyBoundary
    ? length === boundary
    : length >= boundary && (length - boundary) % (tail.step || field.size) === 0;
}

// Merge independently described forms by record order. Fields absent from a
// known short form are zero; incompatible meanings are refused explicitly.
function mergeDecoded(groups) {
  const nonempty = groups.filter(({ count }) => count > 0);
  if (!nonempty.length) return groups[0];
  if (nonempty.length === 1) return nonempty[0];
  nonempty.sort((left, right) => right.recordLength - left.recordLength);
  const fields = new Map();
  for (const group of nonempty) {
    for (const field of group.fields) {
      const previous = fields.get(field.name);
      if (previous && (previous.kind !== field.kind || previous.unit !== field.unit)) {
        throw new Error(
          `CDB field ${field.name} has incompatible types or quantities across stored forms.`,
        );
      }
      if (!previous || field.count > previous.count) fields.set(field.name, { ...field });
    }
  }
  const count = nonempty.reduce((total, group) => total + group.count, 0);
  const columns = {};
  for (const field of fields.values()) {
    const sample = nonempty.find((group) => group.columns[field.name])?.columns[field.name];
    columns[field.name] = Array.isArray(sample)
      ? new Array(count * field.count).fill("")
      : new COLUMN_TYPES[field.kind](count * field.count);
  }
  const order = nonempty
    .flatMap((group) =>
      Array.from({ length: group.count }, (_, slot) => ({
        group,
        slot,
        index: group.indices[slot],
      })),
    )
    .sort((left, right) => left.index - right.index);
  const indices = new Int32Array(count);
  const recordLengths = new Int32Array(count);
  order.forEach(({ group, slot, index }, target) => {
    indices[target] = index;
    recordLengths[target] = group.recordLength;
    for (const field of group.fields) {
      const width = fields.get(field.name).count;
      for (let element = 0; element < field.count; element += 1) {
        columns[field.name][target * width + element] =
          group.columns[field.name][slot * field.count + element];
      }
    }
  });
  return {
    ...nonempty[0],
    count,
    columns,
    fields: [...fields.values()],
    indices,
    recordLengths,
    stored: nonempty.map(({ recordLength, count: rows }) => ({
      length: recordLength,
      count: rows,
    })),
  };
}

function mismatch(layout, length, version) {
  const error = new Error(
    `CDB holds ${layout.name} at ${length} bytes; SOFiSTiK ${version || "selected"} describes ${layout.size} bytes, ` +
      "and no installed release or declared variable tail describes the stored form.",
  );
  error.code = "ERR_CDB_LAYOUT_MISMATCH";
  return error;
}

function decodeKind(
  context,
  layout,
  read,
  {
    decodePolicy = "variable-tail",
    select,
    isolated = false,
    claims = new Map(),
    variableTail,
    documentedPrefix,
    allowUnclassified = false,
  } = {},
) {
  validateDecodePolicy(decodePolicy);
  const lengths = new Set();
  const unrelated = new Map();
  for (let index = 0; index < read.lengths.length; index += 1) {
    if (select && !select[index]) continue;
    const length = read.lengths[index];
    const owners = claims.get(length) || [layout.name];
    if (length === layout.size || isolated || owners.every((name) => name === layout.name))
      lengths.add(length);
    else unrelated.set(length, (unrelated.get(length) || 0) + 1);
  }
  const groups = [];
  const provenance = [];
  for (const length of lengths) {
    let chosen = layout;
    let version = context.version;
    let mode = "exact";
    let alsoDescribedBy;
    let prefixLength = null;
    if (length !== layout.size) {
      const found = layoutDescribing(
        { ...context, siblings: context.siblings() },
        layout.name,
        length,
      );
      if (found.ambiguous)
        throw new Error(
          `CDB ${layout.name} at ${length} bytes has ambiguous installed layouts: ${found.ambiguous.map((v) => v.join(", ")).join("; ")}.`,
        );
      if (found.layout) {
        chosen = found.layout;
        version = found.version;
        alsoDescribedBy = found.alsoDescribedBy;
      } else if (decodePolicy !== "exact" && knownTail(layout, length, variableTail)) {
        mode = "variable-tail";
      } else if (
        decodePolicy !== "exact" &&
        documentedPrefix &&
        length === layout.fields.find(({ name }) => name === documentedPrefix.storedBefore)?.offset
      ) {
        prefixLength = layout.fields.find(({ name }) => name === documentedPrefix.before)?.offset;
        if (!(prefixLength > 0 && prefixLength < length))
          throw mismatch(layout, length, context.version);
        mode = "documented-prefix";
      } else if (decodePolicy === "assumed-prefix" && length < layout.size) {
        mode = "assumed-prefix";
      } else if (allowUnclassified && decodePolicy !== "exact") {
        const count = Array.from(read.lengths).filter(
          (size, index) => size === length && (!select || select[index]),
        ).length;
        unrelated.set(length, count);
        provenance.push({ length, count, mode: "unclassified", version: context.version });
        continue;
      } else throw mismatch(layout, length, context.version);
    }
    const prefix =
      prefixLength == null
        ? chosen
        : {
            ...chosen,
            fields: chosen.fields.filter(
              (field) => field.offset + field.size * field.count <= prefixLength,
            ),
          };
    const decoded = decodeText(decodeRecords(prefix, read, { select, storedLength: length }));
    if (prefixLength != null) {
      decoded.partial = {
        ...decoded.partial,
        decodedLength: prefixLength,
        omittedBytes: length - prefixLength,
        dropped: chosen.fields
          .filter((field) => field.offset >= prefixLength)
          .map(({ name }) => name),
      };
    }
    if (mode === "assumed-prefix" && decoded.partial) decoded.partial.assumed = true;
    groups.push(decoded);
    provenance.push({
      length,
      count: decoded.count,
      mode,
      version,
      ...(alsoDescribedBy?.length ? { alsoDescribedBy } : {}),
      ...(decoded.partial ? { partial: decoded.partial } : {}),
    });
  }
  if (!groups.length)
    groups.push(
      decodeText(decodeRecords(layout, { data: Buffer.alloc(0), lengths: new Int32Array() })),
    );
  const result = mergeDecoded(groups);
  result.skipped = [...unrelated].map(([length, count]) => ({ length, count }));
  result.provenance = provenance;
  return result;
}

module.exports = { DECODE_POLICIES, decodeKind, knownTail, mergeDecoded, validateDecodePolicy };
