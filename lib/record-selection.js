// Telling apart the record kinds that share a CDB key.
//
// CDB stores several kinds under one key and gives a reader nothing but the
// bytes: the kinds are separated by their length where that is unambiguous, and
// by their leading ints where it is not. SOFiSTiK writes those ints beside the
// key in its own help - 105/LC:+:1????? is a thermal eigenstress, 001/NR:1:2???
// a steel material - and the catalog states them the same way, so what a record
// is recognised by is the documented thing rather than an inference.

// A kind's condition is one range over one of its leading ints, or several that
// must all hold. One is enough where a kind's id is its own: a section's polygon
// points declare 101 and nothing else under that key does. It is not enough for
// a material, where five kinds share the id 1 and are told apart by the type
// that follows it - the help writes that as 001/NR:1:2???, an id and a band.
function conditionsOf(when) {
  if (!when) return [];
  return Array.isArray(when) ? when : [when];
}

function fieldOf(condition) {
  return condition.field ?? 0;
}

// How many leading ints a set of conditions needs read. A record shorter than
// that reads zero for the ints it does not reach, which is what CDB means by
// not storing them.
function wordsNeeded(conditions) {
  return conditions.reduce((most, condition) => Math.max(most, fieldOf(condition) + 1), 0);
}

function leadingWords(read, position, length, count) {
  const words = new Array(count);
  for (let word = 0; word < count; word += 1) {
    words[word] = length >= word * 4 + 4 ? read.data.readInt32LE(position + word * 4) : 0;
  }
  return words;
}

function holds(conditions, words) {
  return conditions.every((condition) => {
    const value = words[fieldOf(condition)];
    return (
      (condition.min == null || value >= condition.min) &&
      (condition.max == null || value <= condition.max)
    );
  });
}

// Records a kind's own condition rejects are not that kind.
function narrow(mask, read, when) {
  const conditions = conditionsOf(when);
  if (!conditions.length) return mask;
  const depth = wordsNeeded(conditions);
  const narrowed = mask ? Uint8Array.from(mask) : new Uint8Array(read.lengths.length).fill(1);
  let position = 0;
  for (let index = 0; index < read.lengths.length; index += 1) {
    const length = read.lengths[index];
    if (!holds(conditions, leadingWords(read, position, length, depth))) narrowed[index] = 0;
    position += length;
  }
  return narrowed;
}

// Several record kinds share a key and are told apart by their leading ints, not
// by their length: beam stresses store tendon stresses under a negative second
// int and thermal eigenstresses under a second int above 100000, exactly as the
// help writes them (105/LC:+:-, 105/LC:+:1?????). Reading the leading ints is
// what makes those kinds separable even when an older database stores them in a
// shorter form than the installed headers describe.
//
// The first kind whose condition holds takes the record, so a kind whose band
// lies inside another's is declared before it - a fluid is 001/NR:1:08??, inside
// the 001/NR:1:0??? of the constants it would otherwise be read as.
function selectionsFor(read, variants) {
  if (!variants.length) return null;
  const conditions = variants.map(({ when }) => conditionsOf(when));
  const depth = Math.max(...conditions.map(wordsNeeded));
  const masks = variants.map(() => new Uint8Array(read.lengths.length));
  const items = new Uint8Array(read.lengths.length).fill(1);
  let position = 0;
  for (let index = 0; index < read.lengths.length; index += 1) {
    const length = read.lengths[index];
    const words = leadingWords(read, position, length, depth);
    conditions.forEach((variant, order) => {
      if (items[index] && holds(variant, words)) {
        masks[order][index] = 1;
        items[index] = 0;
      }
    });
    position += length;
  }
  return { masks, items };
}

module.exports = { conditionsOf, holds, leadingWords, narrow, selectionsFor, wordsNeeded };
