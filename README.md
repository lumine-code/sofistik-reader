# sofistik-reader

Read SOFiSTiK CDB databases through isolated native sessions.

The library for read-only access to the stable SOFiSTiK CDB C interface. It owns interface resolution, native loading, one child process per database, and deterministic clean up.

> **NOTE**: This package is not an official SOFiSTiK product and is not affiliated with or endorsed by SOFiSTiK AG.

## Features

- **Version-selected runtime**: resolves the 64-bit interface DLL from the SOFiSTiK release year and edition, covering every release from 2018 to 2026 including the 2018 and 2020 series that predate the year-named interface.
- **Process isolation**: gives each database object its own Node child process so DLL search paths and native reader state do not leak between models.
- **Read-only model access**: reads elements, sections, materials, groups, load cases, and the force, stress and reinforcement results stored against them.
- **Coordinate fidelity**: returns coordinates, local axes and result vectors exactly as the database stores them.
- **Columnar results**: decodes a read into one typed array per field, so a large model costs an allocation per field rather than an object per record.
- **Cross-release decoding**: reads a record stored in a form the selected release does not describe by taking the layout from whichever installed release does.

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

### Records that share a key

CDB stores several record kinds under one key and gives a reader nothing but the bytes. Where their lengths differ, the length tells them apart. Where they do not, SOFiSTiK's own help states the discriminator beside the key — `105/LC:+:1?????` is a thermal eigenstress, `001/NR:1:2???` a steel material — and a catalogue entry says the same thing, as a range over one of a record's leading ints, or several ranges that must all hold.

A material needs both. Its constants, concrete, steel, timber and brickwork records are every one of them 140 bytes with a leading int of 1, and the type behind that int is what separates them: the constants take `0???`, a fluid the `08??` inside it, concrete `1???`, steel `2???`, timber `3???`, brickwork `1?????`. So a material is read whole, and each kind arrives as its own part, present only when the material is of that kind:

```js
const material = await database.read("material", 3);
material.columns.title; // ["Reinforcement"]
material.steel.count; // 1
material.steel.columns.fy; // the yield strength
material.concrete.count; // 0 - this material is not concrete
```

The bands are the ones the help documents and they have not moved since 2018. A kind whose band lies inside another's is declared first, because the first kind whose condition holds takes the record.

### Records across releases

The length CDB stores a record at is the layout it was written with, and the release opening a database is not always the release that wrote it. SOFiSTiK changes record layouts between releases in three ways, and only the first is harmless: a field appended to the end, a field inserted into the middle, and a run of fields dropped out of the middle. `CDB_SECT_PAN` grew from 96 bytes to 100 in 2025; `CDB_SECT_PPT` gained a field in the middle the same year; `CDB_BEAM_FOR` lost ten fields out of the middle in 2024.

So a record is decoded with a layout whose size **is** the stored size, never by truncating a longer one to fit. When the selected release does not describe the stored form, the releases installed beside it are asked, and the one that describes exactly that length answers. The read then reports where its layout came from:

```js
const section = await database.read("section", 71);
section.panels.count; // 8
section.panels.describedBy; // { version: "2025", length: 100, alsoDescribedBy: ["2026"] }
```

A key is read into a buffer sized by the largest record the selected release describes under it, and grown and read again when CDB reports one longer than that — a later release storing a bigger record is read rather than refused.

Two releases that lay a length out identically but renamed a field are not in disagreement — the bytes decode to the same numbers — and the release nearest the one being read through supplies the names. Two that lay it out differently are refused rather than guessed between. When no installed release describes the stored form at all, the read says so, naming the lengths the key holds and the releases that were asked.

**What this cannot see.** SOFiSTiK has twice changed a record's meaning without changing its length, and nothing in the database distinguishes the two forms — the record version CDB stores is not maintained, and the `_VER` macro in the headers is frozen at a value the layout has since outgrown. In those cases the selected release is taken at its word:

| record        | releases                         | what moved                                                                                                                |
| ------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `CDB_GRP`     | 2018–2020 against 2022 and later | everything from offset 32 on: `faks`, `faka`, `fakt`, `vtot`, `mtot`, `rtot` became `ibb`, `ibd`, `ibg`, `v1`, `v2`, `v3` |
| `CDB_LC_CTRL` | 2018–2024 against 2025 and later | `name` shortened by one code and `access` inserted behind it                                                              |

Reading either of those across that boundary needs the release the database was written with. Everything else in the catalogue decodes to the same values through every release from 2018 to 2026 that describes it.

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

Reads one record kind from `RECORDS`. `secondary` is the load case, section or material number the record is stored under, when the key does not fix it. Returns `{count, fields, columns, indices, envelope, recordLength, partial, describedBy}`, plus a named entry for each part a key carries — a beam's cross-sections arrive as `beams.sections`, with an `owners` column naming the beam each one belongs to. Nothing is cached: the caller decides how long to hold a result.

### `database.keys(name)`

The secondary keys a record kind is actually stored under — the load case numbers of a database, the section numbers — as an `Int32Array`.

### `toObjects(read)`

Turns a read's columns into one plain object per record.

### `database.dispose()`

Closes the native reader and its child process. Disposal is idempotent.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
