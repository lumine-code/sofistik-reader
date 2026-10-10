// CDB storage units described by SOFiSTiK quantity codes, converted to SI.
// Presentation units and renderer-specific shapes belong to consumers.

const KILO = 1000;

// code -> what a CDB stores it in, and what it takes to make that SI.
const UNITS = new Map([
  [17, { stored: "1/m", factor: 1 }],
  [62, { stored: "kN", factor: KILO }],
  [83, { stored: "kNm2", factor: KILO }],
  [1000, { stored: "m", factor: 1 }],
  [1001, { stored: "m", factor: 1 }],
  [1002, { stored: "m2", factor: 1 }],
  [1003, { stored: "m", factor: 1 }],
  [1004, { stored: "rad", factor: 1 }],
  [1005, { stored: "1/m", factor: 1 }],
  [1006, { stored: "m", factor: 1 }],
  [1007, { stored: "m2", factor: 1 }],
  [1008, { stored: "m3", factor: 1 }],
  [1009, { stored: "1/m", factor: 1 }],
  [1010, { stored: "m", factor: 1 }],
  [1011, { stored: "m", factor: 1 }],
  [1012, { stored: "m2", factor: 1 }],
  [1013, { stored: "m3", factor: 1 }],
  [1014, { stored: "m4", factor: 1 }],
  [1025, { stored: "m", factor: 1 }],
  [1026, { stored: "m", factor: 1 }],
  [1081, { stored: "-", factor: 1 }],
  [1090, { stored: "kN/m2", factor: KILO }],
  [1092, { stored: "kN/m2", factor: KILO }],
  [1093, { stored: "kN/m2", factor: KILO }],
  [1095, { stored: "kN/m", factor: KILO }],
  [1098, { stored: "kNm/rad", factor: KILO }],
  [1101, { stored: "kN", factor: KILO }],
  [1102, { stored: "kN", factor: KILO }],
  [1103, { stored: "kNm", factor: KILO }],
  [1104, { stored: "kNm", factor: KILO }],
  [1105, { stored: "kNm2", factor: KILO }],
  [1151, { stored: "kN", factor: KILO }],
  [1152, { stored: "kNm", factor: KILO }],
  [1153, { stored: "kN/m", factor: KILO }],
]);

function isKnownUnit(code) {
  return UNITS.has(code);
}

// The factor a stored value is multiplied by to make it SI. A field that names
// no quantity is dimensionless. An unknown declared code is refused; callers
// can inspect `isKnownUnit` and `storedUnit` before deciding how to handle it.
function siFactor(code) {
  if (code == null) return 1;
  const unit = UNITS.get(code);
  if (!unit) {
    const error = new RangeError(`No SI conversion is known for SOFiSTiK quantity ${code}.`);
    error.code = "ERR_CDB_UNIT_UNSUPPORTED";
    throw error;
  }
  return unit.factor;
}

function storedUnit(code) {
  return UNITS.get(code)?.stored ?? null;
}

// The factor for a named field of a read, from the code its own layout states.
// A read carries its fields, so nothing here has to know which record it came
// from - which is what keeps this table a table rather than a list of special
// cases.
function fieldFactor(read, name) {
  const field = read?.fields?.find((entry) => entry.name === name);
  return field?.unit == null ? 1 : siFactor(field.unit);
}

module.exports = { fieldFactor, isKnownUnit, siFactor, storedUnit };
