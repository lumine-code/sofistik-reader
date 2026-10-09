// SOFiSTiK meanings independent of any editor or renderer contract.
const SECTION_FLAGS = Object.freeze({
  plateNonEffective: 1024 | 2048 | 4096,
  polygonNonEffective: 4 | 8 | 16,
  polygonInnerBoundary: 1,
  // PPT_IDP_TP is VERT TYPE TP: an intersection of tangents controlling a
  // fillet, rather than a vertex on the generated boundary.
  polygonTangentIntersection: 32,
  polygonGeneratedStart: 100,
  plateGenerated: 64,
});

const SHELL_FLAGS = Object.freeze({
  eccentricUpside: 64,
  eccentricDownside: 128,
  orthotropic: 256,
});

const GROUP_FLAGS = Object.freeze({ active: 2 });

function restraintMask(fixity) {
  return ~fixity & 63;
}

function groupOf(number, divisor, bases = []) {
  if (!Number.isFinite(number) || number <= 0) return null;
  if (divisor > 0) {
    const group = Math.floor(number / divisor);
    return group > 0 ? group : null;
  }
  let found = null;
  for (const { ng, min } of bases) {
    if (min > number) break;
    found = ng;
  }
  return found;
}

// NODE_KIN stores type + 100*depth + 10000*group in KTL. Its group is
// independent of both the coupled node's number and the system group divisor.
function couplingGroupOf(ktl) {
  return Number.isSafeInteger(ktl) && ktl >= 0 ? Math.floor(ktl / 10000) : null;
}

module.exports = {
  GROUP_FLAGS,
  SECTION_FLAGS,
  SHELL_FLAGS,
  couplingGroupOf,
  groupOf,
  restraintMask,
};
