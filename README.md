# sofistik-reader

Read SOFiSTiK CDB databases through isolated native sessions.

The library owns read-only CDB access, one native subprocess per database, record decoding and reusable SOFiSTiK semantics. It has no editor or renderer dependencies.

> **NOTE**: This package is not an official SOFiSTiK product and is not affiliated with or endorsed by SOFiSTiK AG.

## Features

- **Version-selected runtime**: resolves the installed 64-bit interface for an explicit release and edition, including the older 2018 and 2020 DLL names.
- **Process isolation**: keeps each database's DLL search paths and native state in its own subprocess, with request deadlines and bounded shutdown.
- **Model and result records**: reads elements, sections, materials, groups, load cases, forces, stresses and reinforcement.
- **Columnar results**: returns typed arrays with original coordinates, field quantity codes and record order.
- **Described decoding**: uses installed header layouts and documented variable tails, with explicit provenance for every stored form.
- **Domain helpers**: exposes material bands, packed identifiers, secondary-group selections, restraint masks, group membership and section and shell flags through the public API.

## Installation

Install from an immutable Git commit:

```sh
npm install github:lumine-code/sofistik-reader#<commit-sha>
```

The package is distributed through Git pins. Native CDB access requires Windows and a licensed SOFiSTiK installation; pure decoding and domain helpers run on every supported Node platform.

## Usage

```js
const { openDatabase } = require("@lumine-code/sofistik-reader");
const database = openDatabase("C:/models/frame.cdb", {
  version: "2026",
  edition: "professional",
});

async function read() {
  try {
    const nodes = await database.read("nodes");
    const cases = await database.keys("nodeResults");
    const displacements = await database.read("nodeResults", cases[0]);
    return { nodes, displacements };
  } finally {
    await database.dispose();
  }
}
```

## Reading records

`RECORDS` names the supported kinds. A read returns `{name, key, record, count, fields, columns, indices, recordLength, skipped, provenance, envelope}`, plus named blocks for parts sharing the key. Fields retain SOFiSTiK names without the `m_` prefix and carry their quantity code as `unit`. Packed text fields are strings. Parts carry `owners` identifying the preceding element. `toObjects(read)` builds plain records when that shape is more convenient.

`beams.sections` holds cross-sections, `material` holds separate concrete, steel and other material blocks, and `beamStresses` holds tendon and thermal blocks. `beamStiffness` reads key 103; `beamHingeReactions` reads key 111 and preserves the hinge type alongside its reaction and state variables. Result envelopes return `max` and `min`; continuation records gain an `element` column, with negative left-bank numbers resolved to their absolute element number; banded material numbers gain `material`, `materialKind` and optional `materialName`; nodal result records gain `supported`. A merged read carries `recordLengths` and `stored` so every decoded row retains its original stored length.

Pass `{includeEnvelope: false}` as the third argument to `read` when only individual result records are needed. All leading identifier-zero summary records are omitted without interpreting their layout; the result reports their count and stored lengths in `omittedEnvelope`. This also covers per-material stress summaries. Continuation records after the first element remain intact, and malformed element records still fail under the selected decode policy.

### Decode policies

`database.read(name, secondary, {decodePolicy})` accepts one of the exported `DECODE_POLICIES`:

| Policy           | Behavior                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `exact`          | Requires the selected or another installed release to describe each form exactly.                              |
| `variable-tail`  | The default. Also accepts explicitly catalogued optional tails and arrays, whose boundaries come from headers. |
| `assumed-prefix` | Additionally permits a shorter unknown form to use the selected layout's prefix, marked as an assumption.      |

Installed sibling layouts are consulted before any tail or prefix interpretation. All describable lengths are merged in original record order; unknown larger primary records are refused even when other rows decode. The catalogue declares optional support reactions, group suffixes, shell finite-cell fields, spring nonlinear/damping fields, beam-result parameters and variable lists explicitly. It never treats every shorter record as an optional tail.

Every block's `provenance` contains `{length, count, mode, version}`, where `mode` is `exact`, `variable-tail`, `documented-prefix`, `assumed-prefix` or `unclassified`. Short forms also report `partial.dropped` and `partial.shortened`. An assumed prefix adds `partial.assumed: true`; inserted or removed middle fields make that interpretation unsafe, so callers must opt in explicitly. Fields absent from a documented short form are padded when forms are merged.

The documented-prefix case is narrowly defined for key-112 records stored through the PHIZ boundary: DATEN defines their force prefix through MT2 but limits the following deformation meanings to key 102. The reader therefore exposes the forces and omits those trailing bytes, reporting `partial.decodedLength`, `partial.omittedBytes` and every omitted field in `partial.dropped`. It does not treat those bytes as displacement results. Other unknown lengths remain errors, and the `exact` policy refuses this projection. Stress records and envelopes under key 105 accept the documented optional tail beginning at SIGO; absent stresses must be distinguished from actual zeros using the per-form provenance.

Some optional parts cannot be identified or described. Under the default policy they remain counted in `skipped` and `unclassified` provenance; exact mode refuses them. Other record kinds sharing a union remain listed in `skipped` without being decoded as the requested kind. Unavailable kinds throw `ERR_CDB_RECORD_UNAVAILABLE`; unresolved primary layouts throw `ERR_CDB_LAYOUT_MISMATCH`.

Two releases with conflicting placements at the same stored length are refused when resolving a sibling layout. Changes of meaning at an unchanged length cannot be detected from the database: `CDB_GRP` changed after 2020, and `CDB_LC_CTRL` changed in 2025. Reading those across the boundary requires selecting the release that wrote the database.

### Public domain helpers

`packedName(number)` decodes a four-character identifier. `secondaryGroupSelection(numbers)` returns `{ranges, references}` for a calculated selection list. `materialKeyOf(number)` returns the material band, indexed by `MATERIAL_KINDS`. `restraintMask(kfix)` returns the six restrained DOF bits. `groupOf(number, divisor, bases)` resolves group membership; fallback bases are sorted by `min`. `SECTION_FLAGS` and `SHELL_FLAGS` name CDB bit fields. `fieldFactor(read, name)` and `siFactor(quantityCode)` convert documented CDB storage units to SI. `isKnownUnit(code)` and `storedUnit(code)` expose conversion coverage; unknown declared quantities throw `ERR_CDB_UNIT_UNSUPPORTED` rather than producing a value labelled SI. Fields without a quantity code use factor one. Renderer-specific shapes, labels and IDs belong to consumers.

## API

`openDatabase(path, options)` returns a lazy `CdbDatabase`. `version` is a required four-digit year; `edition` is `professional` or `educational`, defaulting to Professional. `environmentRoot` defaults to `C:\Program Files\SOFiSTiK`. Installation paths and DLL names come from `@lumine-code/sofistik-context`. `resolveInterface(options)` returns `{version, edition, environmentRoot, installRoot, dllPath}`; `listInterfaces(options)` lists installed interfaces newest first.

`database.read(name, secondary, options)` reads one kind. `secondary` is the load-case, material, section or other key number when not fixed by the catalogue. `database.keys(name, options)` returns its existing secondary keys as an `Int32Array`. Nothing caches query results; consumers own their retention policy.

Both query methods accept `signal` and `timeoutMs`. The default request deadline is 120 seconds, configurable with `requestTimeoutMs` at construction. A deadline or cancellation terminates the owning subprocess because synchronous native work cannot receive a cancellation message; every outstanding query rejects and the database must be reopened. Worker exit, disconnect and send failure are terminal too. `ERR_CDB_TIMEOUT` identifies a deadline failure.

`await database.dispose()` closes the native reader, terminates its owned subprocess and settles pending work. Disposal is idempotent and bounded; `shutdownTimeoutMs` defaults to two seconds for graceful close and two seconds for process termination. Unused databases do not launch a process. A database cannot issue new queries once disposal starts.

## Building

`npm run build` builds the Node-API addon. `npm test` exercises decoding, full record assembly, real subprocess IPC and failure and disposal paths. CI builds and validates on Node 24 on Windows, macOS and Linux. `npm run smoke:native` checks the built addon; `npm run smoke:native -- C:/models/frame.cdb 2026 educational` additionally opens a real database and reads geometry and one solved result case.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
