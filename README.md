# sofistik-reader

Read SOFiSTiK CDB databases through isolated native sessions.

The library for read-only access to the stable SOFiSTiK CDB C interface. It owns interface resolution, native loading, one child process per database, and deterministic clean up.

> **NOTE**: This package is not an official SOFiSTiK product and is not affiliated with or endorsed by SOFiSTiK AG.

## Features

- **Version-selected runtime**: resolves the 64-bit interface DLL from the SOFiSTiK release year and edition, including the 2018 and 2020 series that predate the year-named interface.
- **Process isolation**: gives each database object its own Node child process so DLL search paths and native reader state do not leak between models.
- **Read-only model access**: reads elements, sections, materials, groups, load cases, and the force, stress and reinforcement results stored against them.
- **Coordinate fidelity**: returns coordinates, local axes and result vectors exactly as the database stores them.
- **Columnar results**: decodes a read into one typed array per field, so a large model costs an allocation per field rather than an object per record.

## Installation

```sh
npm install @lumine-code/sofistik-reader
```

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
    const loadCases = await database.keys("loadCase");
    const displacements = await database.read("nodeResults", loadCases[0]);
    return { nodes, displacements };
  } finally {
    await database.dispose();
  }
}
```

## Reading records

The CDB stores records under numeric keys, and what each record contains is described by the headers of the SOFiSTiK installation that owns the interface — so the layouts are read from there, at runtime, once per installation. Nothing about a record is compiled in, which is why one build serves every release.

```js
const nodes = await database.read("nodes");
nodes.count; // 6583
nodes.columns.nr; // Int32Array(6583)
nodes.columns.xyz; // Float32Array(19749), three per node

const forces = await database.read("beamForces", 101); // load case 101
forces.envelope; // the max and min records the key leads with
```

A read returns **columns**: one typed array per field, named as SOFiSTiK names them without the `m_` prefix. Nothing is allocated per record, which is what keeps a large model cheap; `toObjects(read)` builds plain objects when that is more convenient.

`RECORDS` is the catalogue of what can be read, and it is data. A record kind is one entry naming the union that owns the key in SOFiSTiK headers:

```js
beamForces: { key: "BEAM_FOC", items: "CDB_BEAM_FOR", envelope: "CDB_BEAM_FOC", secondary: "loadCase" },
```

The CDB key, the record kinds stored under it, and every field come from the headers. It ships with elements, sections, materials, groups, load cases, and forces, stresses and reinforcement for beams, quads, trusses, cables, springs and design lines.

## Results

`nodeResults`, `springResults`, `beamForces`, `beamStresses`, `trussStresses`, `quadForces` and `quadStresses` are read one load case at a time, and each is mapped the way `cdbase.chm` documents its key:

```js
const stresses = await database.read("beamStresses", 101, { partial: true });
stresses.columns.element; // the beam each record belongs to
stresses.columns.material; // the material, tendon or reinforcement number
stresses.columns.materialKind; // which of those it is, indexing MATERIAL_KINDS
stresses.envelope.max.sigt; // the maximum the key leads with
stresses.tendons; // stresses in tendons, stored under the same key
```

- **Envelope.** A results key leads with the maximum and the minimum of everything under it, identified by their leading zero. They come back as `envelope.max` and `envelope.min`, plain records rather than columns.
- **Continuation.** A beam-like result numbered 0 continues the element before it — the help calls it a jump, the two banks of a discontinuity sharing one station. The `element` column resolves it, so every record names its element.
- **Material bands.** A beam result identifies itself through a banded material number: a tendon, admissible stresses, the maxima for the solid material, for tendons or for reinforcements, or four characters naming a stress point or a shear cut. That becomes `material`, `materialKind` (indexing the exported `MATERIAL_KINDS`) and `materialName`.
- **Support reactions** share the node record and are stored only where a node is supported, so `supported` marks the ones that carry a reaction.
- **Kinds sharing a key.** Tendon stresses, thermal eigenstresses and the nonlinear stress header are stored under the same key as the stresses themselves and are told apart by their leading integers, not by their length. They arrive as named blocks — `tendons`, `thermal`, `nonlinear` — each with an `owners` column naming the element it belongs to, exactly as a beam's `sections` do.
- **Stored forms.** One kind can be stored in more than one length: an unsupported node stores no reactions at all. With `{ partial: true }` the forms are merged back into record order, `stored` reports how many of each, and a field the shorter form omits reads as zero.

A record kind is decoded only when its stored length matches the layout the installed headers describe. A database written by an older release stores an older, usually shorter, record; that read fails naming both lengths rather than decoding whatever follows. Pass `{ partial: true }` to decode the fields that do fit — the result then carries `partial.dropped`, the fields that were not stored.

## API

### `openDatabase(databasePath, options)`

Returns a lazy `CdbDatabase`. The database is opened read-only on the first query. Options:

- `version` — the SOFiSTiK release year, such as `"2026"`. Required.
- `edition` — `"professional"` or `"educational"`, defaulting to `"professional"`.
- `environmentRoot` — the directory holding the installed versions, defaulting to `C:\Program Files\SOFiSTiK`. The installation is `<environmentRoot>/<version>/SOFiSTiK <version>`.

### `resolveInterface(options)`

Returns `{ version, edition, installRoot, dllPath }` for the same options, so an application can validate or display the selected interface before opening a database. A missing installation or a missing interface is reported here, by path, and names the releases that are installed instead.

### `listInterfaces(options)`

Returns `[{ version, installRoot, editions }]` for everything installed below `options.environmentRoot`, newest first, and an empty array when SOFiSTiK is absent. This is how an application answers "is SOFiSTiK installed, and which releases?" without opening a database. Nothing is ever copied out of an installation: the interface is loaded from where SOFiSTiK put it.

### `database.read(name, secondary, options)`

Reads one record kind from `RECORDS`. `secondary` is the load case, section or material number the record is stored under, when the key does not fix it. Returns `{count, fields, columns, indices, envelope, recordLength, partial}`, plus a named entry for each part a key carries — a beam's cross-sections arrive as `beams.sections`, with an `owners` column naming the beam each one belongs to. Nothing is cached: the caller decides how long to hold a result.

### `database.keys(name)`

The secondary keys a record kind is actually stored under — the load case numbers of a database, the section numbers — as an `Int32Array`.

### `toObjects(read)`

Turns a read's columns into one plain object per record.

### `database.dispose()`

Closes the native reader and its child process. Disposal is idempotent.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
