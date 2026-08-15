const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_ENVIRONMENT_ROOT = "C:\\Program Files\\SOFiSTiK";

// The educational build is the same interface under a marked file name.
const EDITIONS = Object.freeze({ professional: "", educational: "_edu" });

// SOFiSTiK renamed the interface twice before settling on the release year: 2018
// ships the 50 series, 2020 the 70 series, and everything since is named after
// itself. A future release needs no entry here.
function interfaceFileName(version, edition) {
  const mark = EDITIONS[edition];
  if (version === "2018") return `cdb_w${mark}50_x64.dll`;
  if (version === "2020") return `sof_cdb_w${mark}-70.dll`;
  return `sof_cdb_w${mark}-${version}.dll`;
}

function normalizeVersion(version) {
  if (version == null || version === "") {
    throw new TypeError('A SOFiSTiK "version" is required, for example "2026".');
  }
  const text = String(version).trim();
  if (!/^\d{4}$/.test(text)) {
    throw new RangeError(`A SOFiSTiK version is a four-digit release year, not "${version}".`);
  }
  return text;
}

function normalizeEdition(edition = "professional") {
  if (!Object.hasOwn(EDITIONS, edition)) {
    throw new RangeError(
      `A SOFiSTiK edition is "professional" or "educational", not "${edition}".`,
    );
  }
  return edition;
}

function installRootFor(environmentRoot, version) {
  return path.join(environmentRoot, version, `SOFiSTiK ${version}`);
}

function interfacePath(installRoot, version, edition) {
  return path.join(installRoot, "interfaces", "64bit", interfaceFileName(version, edition));
}

function existsFor(options) {
  return options.exists || ((filePath) => fs.existsSync(filePath));
}

// Reports which SOFiSTiK releases are installed, newest first, so an application
// can tell a user that nothing is installed instead of failing one database at a
// time. The interface is always read from where SOFiSTiK put it; nothing is ever
// copied out of an installation.
function listInterfaces(options = {}) {
  const exists = existsFor(options);
  const readdir =
    options.readdir ||
    ((directory) => {
      try {
        return fs.readdirSync(directory);
      } catch {
        return [];
      }
    });
  const environmentRoot = path.resolve(options.environmentRoot || DEFAULT_ENVIRONMENT_ROOT);
  const installed = [];
  for (const entry of readdir(environmentRoot)) {
    if (!/^\d{4}$/.test(entry)) continue;
    const installRoot = installRootFor(environmentRoot, entry);
    if (!exists(installRoot)) continue;
    const editions = Object.keys(EDITIONS).filter((edition) =>
      exists(interfacePath(installRoot, entry, edition)),
    );
    if (editions.length) installed.push({ version: entry, installRoot, editions });
  }
  return installed.sort((left, right) => right.version.localeCompare(left.version));
}

function installedSummary(environmentRoot, options) {
  const installed = listInterfaces({ ...options, environmentRoot });
  if (!installed.length) return `No SOFiSTiK release is installed below ${environmentRoot}.`;
  return `Installed below ${environmentRoot}: ${installed
    .map(({ version, editions }) => `${version} (${editions.join(", ")})`)
    .join(", ")}.`;
}

// Resolves the 64-bit CDB interface for a release year, so callers select a
// SOFiSTiK version rather than a file.
function resolveInterface(options = {}) {
  const exists = existsFor(options);
  const edition = normalizeEdition(options.edition);
  const version = normalizeVersion(options.version);
  const environmentRoot = path.resolve(options.environmentRoot || DEFAULT_ENVIRONMENT_ROOT);
  const installRoot = installRootFor(environmentRoot, version);
  if (!exists(installRoot)) {
    throw new Error(
      `SOFiSTiK ${version} is not installed. ${installedSummary(environmentRoot, options)}`,
    );
  }
  const dllPath = interfacePath(installRoot, version, edition);
  if (!exists(dllPath)) {
    throw new Error(`The ${edition} SOFiSTiK ${version} CDB interface is missing: ${dllPath}`);
  }
  return { version, edition, installRoot, dllPath };
}

module.exports = { DEFAULT_ENVIRONMENT_ROOT, listInterfaces, resolveInterface };
