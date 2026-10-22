# The FundaCAD document files: .funda and .fundab

A document is saved in one of two formats, chosen by the extension, the way a
slicer writes `.gcode` or `.bgcode`:

| Extension | Format | For |
|---|---|---|
| `.funda` | JSON, pretty-printed | reading, diffing, version control, scripts |
| `.fundab` | binary, format 2 below | smaller files, error correction, large imports |

Saving picks the format from the extension. Opening ignores the extension and
reads the format from the first bytes, so a file with the wrong name still opens.
`.neocad`, `.sindri` and `.json` are older names and are saved as JSON.

## JSON (.funda)

The document object exactly as the app holds it, indented by two spaces. When the
document has imported bodies, one more top-level key comes last:

```json
{
  "version": 10,
  "features": [ { "id": "f1", "type": "import", "geom": "5648909c8c0ccf6096c0e672255e68a0" } ],
  "geometry": {
    "5648909c8c0ccf6096c0e672255e68a0": "<base64 of the binary BREP>"
  }
}
```

- Each key of `geometry` is the lowercase hex BLAKE2b-128 of the decoded bytes,
  and a reader refuses the file when they differ.
- The bytes are OCCT BinTools, the same blobs the binary format stores.
- A reader removes `geometry` from the document after publishing the blobs; the
  rest of the app never sees it.
- A document without imports has no `geometry` key and is plain JSON.
- A writer must embed the geometry of every import, and refuses to save when a
  blob is missing. It also embeds the blob of any other hash shaped string in
  the document when it has that blob, and skips it otherwise, so geometry a
  feature of a type it does not know refers to survives a save.
- `referenceImages` is a list the Reference images plugin owns, one entry per
  picture on a plane (`id`, `name`, `image`, `mime`, `px`, `plane`, `at`,
  `width`, `angle`, `flipX`, `flipY`, `opacity`, `locked`, `hidden`). `image`
  is the hash of the PNG or JPEG bytes, embedded in `geometry` like any other
  hash string value, so those bytes are an image, not a BREP. A version without
  the key carries it as an unknown top level key, image included.
- `sectionView` is the section cut that is on, absent when none is: `origin` (a
  point on the defining plane, mm), `normal` (its unit normal), `offset` (mm
  along `normal` to the cut), `side` (1 keeps the half `normal` points into, -1
  the other) and `ghost` (`hidden`, `faint`, `soft` or `strong`, how the removed
  half is drawn). It is a view: the engine never reads it, undo leaves it alone
  and versions leave it out. Restoring a version, or an assistant's or a
  plugin's edit of the open document, keeps the cut on screen whatever cut the
  edit holds. Unknown fields are kept, and a version without the key carries it
  as an unknown top level key.

The reference writer and reader is `crates/fundacad-format/src/json_doc.rs`.
The browser build has no Rust to call, so `src/io/files.ts` writes and reads the
same map itself through the engine's blob store, and refuses a download that
would lose an import's geometry.

### Materials

Each entry of the document's material library needs `id`, `name` and `color`
(`"#rrggbb"`). Every other field is optional and left out when it holds its
default. A reader clamps a number that is out of range and drops a field of the
wrong type. These finish fields came with the filament materials:

| Field | Range | Default | What it is |
|---|---|---|---|
| `sheen` | 0..1 | 0 | soft velvet rim at grazing angles |
| `anisotropy` | 0..1 | 0 | highlights stretched along the layer lines, or world Z |
| `flakes` | 0..1 | 0 | how many tiny mirror facets the surface has |
| `flakeSize` | 0.01..5 mm | 0.1 | the size of one flake |
| `scatterDistance` | 0..100 mm | 0 | light scattering inside a see-through finish |
| `castsLight` | boolean | true | false keeps a glow off the other parts, written only when false |

A field a reader does not know is kept as it is and written back on save, so a
file from a newer version keeps its materials.

`faceMaterials` maps `bodyId#localFaceIndex` to a material id, at the face
numbering of the build the file was saved with. `facePrints` holds, under the
same keys, a print of each face: `centroid`, `normal`, `area`, `surface`
(`plane` or `curved`), `points` (up to 12 points inside the face, x y z flat)
and `faces` (the body's face count). A fillet or a cut renumbers the faces, and
the print finds each one again. A file without `facePrints` keeps its indices on
its first build; an older reader ignores the prints and reads the indices.

## Binary (.fundab), format 2

A `.fundab` file holds one FundaCAD document and the geometry it references. It is
a binary file that finds and repairs damage to itself: every part of it carries a
checksum, every section carries Reed-Solomon parity, and the index that locates
the sections is stored twice. Between the FundaCAD release that introduced format
2 and the one that split the extensions, these files were also named `.funda`.

The reference writer and reader is `crates/fundacad-format/src/fnda.rs`. This document is the
contract; where the two disagree, the code has a bug.

## Goals

- **Recoverable.** Scattered corruption, a bad sector, a partial overwrite or a
  truncated copy should cost nothing when it is within the parity, and should be
  reported precisely when it is not. A reader never shows wrong geometry: every
  repaired section is proven against its content hash before it is used.
- **Not text.** The document is CBOR (RFC 8949), and every section is compressed.
- **Streamable.** A multi-gigabyte assembly is written and read one shard group
  at a time; nothing requires the whole file in memory.
- **Simple to read without repairing.** The code is systematic: the data shards
  are the stored bytes themselves, so a reader that does no repair can skip the
  parity entirely.

## Conventions

- All integers are little-endian.
- `u8`, `u16`, `u32`, `u64` are unsigned integers of that many bits.
- CRC-32 is the IEEE polynomial (`0xEDB88320` reflected), as in zlib and PNG.
- The content hash is BLAKE2b with a 128-bit (16-byte) digest, the same digest
  the geometry blob store names its files by.
- Deflate is raw RFC 1951 deflate, with no zlib or gzip wrapper.

## File layout

```text
offset 0          Header (64 bytes)
offset 64         Section 1
                  Section 2
                  ...
table_a           Section table, copy A
table_b           Section table, copy B
file_len - 64     Trailer (64 bytes)
```

Sections follow one another with no padding. The two table copies are identical.

## Header and trailer

Both are 64 bytes and have the same layout; only the magic differs.

| Offset | Size | Field | Value |
|---|---|---|---|
| 0 | 8 | magic | `FUNDACAD` in the header, `FNDATAIL` in the trailer |
| 8 | 2 | major | `2` |
| 10 | 2 | minor | `1` (`0` before the segment index, kind `4`) |
| 12 | 4 | flags | `0`, reserved |
| 16 | 8 | table_a | offset of section table copy A |
| 24 | 8 | table_b | offset of section table copy B |
| 32 | 8 | table_len | length of one table copy in bytes |
| 40 | 4 | table_crc | CRC-32 of one table copy |
| 44 | 12 | reserved | zero |
| 56 | 4 | header_crc | CRC-32 of bytes 0 to 55 of this header |
| 60 | 4 | reserved | zero |

A reader that finds `major` greater than it understands refuses the file with a
message saying it was written by a newer FundaCAD. A greater `minor` is readable:
minor versions only add fields in reserved space or new section kinds.

## Section table

| Size | Field |
|---|---|
| 4 | magic `FTBL` |
| 4 | `count`, the number of entries |
| ... | `count` entries |

Each entry:

| Size | Field | Meaning |
|---|---|---|
| 1 | kind | `0` info, `1` document, `2` geometry, `3` mesh, `4` segment index, higher ones are carried (below) |
| 1 | codec | `0` raw, `1` deflate; see "Files from a newer version" for any other |
| 2 | name_len | length of `name` in bytes |
| name_len | name | UTF-8; see below |
| 8 | offset | where the section starts |
| 8 | stored_len | length of the encoded (compressed) bytes |
| 8 | raw_len | length after decoding |
| 16 | raw_hash | BLAKE2b-128 of the decoded bytes |
| 4 | shard_size | bytes per shard, at least 1 |
| 2 | data_shards | `k`, at least 1 |
| 2 | parity_shards | `m`; `k + m` is at most 255 |

Names:

- **info**: `info`. CBOR map with at least `app`, the version string of the
  program that wrote the file, and `hashAlg`, `"blake2b-128"`.
- **document**: `document`. CBOR encoding of the document object, whose own
  shape and `version` field are defined by `src/document/migrate.ts`.
- **geometry**: the lowercase hex content hash of the blob, which must equal
  `raw_hash`. A reader refuses an entry where they differ.
- **mesh**: a cache key of ASCII letters, digits, `-`, `_` and `.`, with no `..`.
  Meshes are a reopen-speed cache; a damaged or unsafe one is skipped, never fatal.
- **segment index**: `segments`. Where the segments of the big sections start,
  see "Segmented sections". At most one, written last.

A name is never used as a path. Extracted geometry is published under the hash
the reader computed and verified.

## Sections

The encoded bytes (`stored_len` of them) are cut into groups of `k` data shards
of `shard_size` bytes each; the last data shard of the last group is padded with
zeros. `groups = ceil(stored_len / (shard_size * k))`.

Each group is written as its `k` data shards followed by `m` parity shards,
computed with Reed-Solomon over GF(2^8) using the systematic Vandermonde-derived
encoding matrix of the `reed-solomon-erasure` crate (the construction Backblaze's
JavaReedSolomon published).

After the last group comes the section's CRC table: one `u32` CRC-32 per shard,
`groups * (k + m)` of them, in the order the shards were written.

```text
group 0:  D0 D1 ... D(k-1)  P0 ... P(m-1)
group 1:  D0 D1 ... D(k-1)  P0 ... P(m-1)
...
CRC table: crc(group 0 D0), crc(group 0 D1), ... crc(last group P(m-1))
```

A section occupies `groups * (k + m) * shard_size + 4 * groups * (k + m)` bytes.

## Segmented sections

A geometry, mesh or carried deflate section of at least two segments (FundaCAD:
2 MiB raw) is compressed in segments, so a writer and a reader can work on all
cores. The info and the document stay one stream, however big. Nothing in its entry,
shards, parity or CRC table changes; only the stored bytes are produced
differently:

```text
stored = S0 || S1 || ... || S(n-1)
Si (i < n-1) = raw deflate of raw[i*seg .. (i+1)*seg] by a fresh compressor, ended by a sync flush
S(n-1)       = raw deflate of the rest by a fresh compressor, ended by a final block
```

A sync flush ends on an empty stored block (`00 00 FF FF`), byte aligned and not
final, so the concatenation is one valid raw deflate stream: a reader that knows
nothing of segments decodes it in one pass to the same bytes. A fresh inflater
fed exactly `Si` gives exactly that segment's raw bytes. Segments carry no
dictionary from the one before, which costs well under 0.5 percent in size.

Where the segments start is in the segment index, a section of kind `4` named
`segments`, codec `1` (deflate) like the others, written after the sections it
describes. All integers little-endian:

| Size | Field |
|---|---|
| 4 | magic `FSEG` |
| 2 | version, `1` |
| 2 | reserved, `0` |
| 4 | `rows` |
| ... | `rows` rows |

Each row:

| Size | Field | Meaning |
|---|---|---|
| 1 | kind | kind of the described section |
| 1 | codec | its codec, `1` |
| 2 | reserved | `0` |
| 4 | n | number of segments, at least 2 |
| 16 | raw_hash | the described section's `raw_hash` |
| 8 | stored_len | the described section's `stored_len` |
| 4 | crc_table_crc | CRC-32 of the described section's CRC table |
| 4 | reserved | `0` |
| 8 n | segments | per segment, `stored_len` u32 then `raw_len` u32 |

The index is advisory. A reader uses a row for a section only when kind,
`raw_hash`, codec `1`, `stored_len` and `crc_table_crc` all match it, `n` is at
most `raw_len / 1024 + 1`, every segment has a `stored_len` of at least 1 and a
`raw_len` from 1 byte to 64 MiB, and the segment lengths add up exactly to the
section's `stored_len` and `raw_len`. Anything else, an index of another version,
a row for a section that is not in the table, or a segment that does not inflate
to exactly its `raw_len`, means the section is decoded as one stream. The whole
section is still proven by `raw_hash`, so a wrong index can cost speed, never
correctness. Several rows for one section: the first that matches wins.

The index is never carried. A writer builds it again from the sections it
actually writes, and drops any kind `4` section it was handed.

## Writing

1. Write 64 zero bytes as a placeholder header.
2. For each section: encode the raw bytes with its codec, hashing the raw bytes
   with BLAKE2b-128 as they pass; cut, compute parity, write the groups and then
   the CRC table.
3. When any section was segmented, write the segment index as one more section.
4. Write the table twice, then the trailer.
5. Seek to 0 and write the header.

The writer builds the file at a temporary path beside the target, flushes it to
stable storage, and renames it over the target, so a crash leaves the old file
or the new one and never a torn one.

Layouts FundaCAD uses, at most, per section:

| Sections | shard_size | k | m | Overhead | Repairs per group |
|---|---|---|---|---|---|
| info, document | 4 KiB | 8 | 4 | 50% | any 4 of 12 shards |
| geometry, mesh | 64 KiB | 32 | 4 | 12.5% | any 4 of 36 shards |

A section shorter than one full group is fitted to its encoded length instead of
padded: `shard_size = clamp(ceil(stored_len / k_max), 64, shard_max)`, then
`k = clamp(ceil(stored_len / shard_size), 1, k_max)`, and `m` stays as in the
table. A 70 KB geometry blob is 32 shards of 2,188 bytes plus 4 parity, not one
2.3 MB group.

A reader must accept any layout within the limits of the section table.

## Reading

1. Read the header. If its magic or `header_crc` does not check, read the trailer
   instead.
2. From the first header that checks, read table copy A; if its CRC does not
   match `table_crc`, read copy B. If neither checks, try the other header's
   offsets. If nothing checks, the file is unreadable.
3. For each section needed, read its CRC table, then each group:
   - A shard is damaged when it is short or its CRC does not match.
   - If no data shard is damaged, the data shards are used as they are.
   - Otherwise, when at most `m` shards of the group are damaged, reconstruct the
     data shards from the survivors. With more, the section is unrecoverable.
4. Concatenate the data shards, truncate to `stored_len`, decode with the codec,
   and require exactly `raw_len` bytes whose BLAKE2b-128 equals `raw_hash`.
5. Before decoding, refuse a section whose `raw_len` exceeds the reader's limit
   (FundaCAD: 8 GiB), so a hostile file cannot make it expand without bound.

A damaged CRC table entry makes its shard look damaged, which costs one of the
group's `m` repairs rather than a wrong answer. A reader reports how many shards it
repaired and whether it had to use a backup header or table; FundaCAD tells the
user and suggests saving, which writes a clean copy.

A reader that does not repair may skip step 3's reconstruction: concatenate the
data shards directly and rely on step 4's hash to reject damage.

The parity shards are only needed for a group with a damaged data shard, so
FundaCAD reads a group's `k` data shards in one read and its `m` parity shards
only then. It also refuses a section whose `stored_len` or group size is larger
than the file, before sizing any buffer from them.

## Speed

Measured with `bench_open` (docs/ENGINE.md 8.1), release build, a 32 thread
Windows machine with NVMe, warm file cache. SV08 is a 154 MB STEP assembly of
1097 bodies, stored as one 68.9 MB blob; the scan is a generated 2,000,000
triangle STL, one 48.0 MB blob.

Saving a `.fundab` is almost all deflate (level 6, one core: 37 MiB/s on SV08,
21 MiB/s on the scan), so segments made it parallel:

| Save | one stream | segments, 4 threads | segments, 16 threads | size change |
|---|---|---|---|---|
| SV08 | 1814 ms | 586 ms | 304 ms | +0.003% |
| scan | 2291 ms | 692 ms | 276 ms | +0.003% |

Deflate level 1 would be faster still, but makes SV08 17 percent bigger
(ratio 0.414 against 0.355), so the level stays 6.

A first open, with nothing of the document in the blob store yet, reads every
segmented section by its index row: the groups of a window are read and
repaired on all threads, the segments inside them are inflated on all threads,
at most 4 MiB raw per thread at a time so very redundant data costs no more
memory than plain data, and the result is hashed and written in order. Sections without a row are
extracted side by side, one per thread. A blob already in the store is skipped
only when its length is right, so a torn one is extracted again. Times for the
whole file layer of a first open (`open_file_empty_store`, the median of three
runs of seven, each writing and syncing the blob):

| First open | one stream | segments, 1 thread | 4 threads | 8 threads | 16 threads |
|---|---|---|---|---|---|
| SV08 | 282 ms | 222 ms | 213 ms | 190 ms | 132 ms |
| scan | 251 ms | 210 ms | 108 ms | 97 ms | 89 ms |

The rest is the BLAKE2b of the whole blob, which stays serial (about 1 GB/s,
66 ms for SV08), and writing and syncing it. Runs on this machine vary by up to
a factor of two with the file system, so only the ordering is firm. The file
layer is a small part of a first open of SV08, whose engine side (shapes, the
rebuild and the mesh) takes over ten seconds; for the scan it was about a
fifth. A reopen finds every blob in the store and takes a few milliseconds.

## Older formats

FundaCAD still reads every format it has written:

- **Format 1**: a ZIP archive (first bytes `PK`) holding `manifest.json`,
  `document.json` and `geom/<hash>.bbrep`, verified by hash but with no repair.
- **Plain JSON with inline `brep`**: a document saved before containers existed,
  its import features carrying text BREP as base64. Migrated to the blob store on
  open.

Only JSON and format 2 are written.

## Files from a newer version

A file a newer FundaCAD wrote still opens, and saving it again loses nothing this
version merely does not understand. The document `version` (`FORMAT_VERSION` in
`src/document/migrate.ts`, `DOCUMENT_VERSION` in `crates/fundacad-core`) is not a
gate: a reader never refuses a file for a higher number.

Reader rules:

- A feature of a type the reader does not know stays in the history where it is,
  is not built, and is written back unchanged. So is a field it does not know on
  a feature it does know.
- A top level key the reader does not know is written back unchanged. `geometry`
  is reserved for the JSON file's embedded blobs (above), never a document key.
- A `stress`, `environment` or `versions` value the reader cannot read is kept
  whole and written back for as long as the document has none of its own.
- A `.fundab` section of a kind above `4` in codec `0` or `1` is verified against
  its `raw_hash`, kept, and written again with the same name, kind and raw bytes
  when the document is saved as `.fundab`. A JSON `.funda` has no sections, so
  saving as `.funda` drops it. A section of such a kind in another codec cannot
  be verified or written back, so it is skipped, and a damaged one never stops
  the open. A document or geometry section in another codec is damage: the open
  fails. So a new codec can never be used for kinds `0` to `3` while released
  readers do not know it. Readers from before minor `1` skip the segment index,
  or carry it as an unknown kind; the index's match rule makes either harmless,
  and an index dropped on save costs only speed.

Writer rules:

- A writer stamps its own `version`, never the higher number it read, because
  what it saves is in its own shapes. A newer reader therefore runs its newer
  migrations on such a file again, so every migration must be shape guarded:
  it rewrites only what still has the old shape, and leaves alone what already
  has the new one. The app saves a newer file this way, and so does MCP
  `doc_save`: a stamp above its own is lowered to its own, the rest of the
  file is written as it was. A stamp below its own stays, because MCP does not
  run the app's migrations and a higher stamp would make the app skip them.
  MCP cannot write a `.fundab`, and a JSON file has no sections, so a section
  carried in a `.fundab` is dropped by an MCP save, as the app drops it when
  it saves as `.funda`. Only the app keeps it, by saving as `.fundab`. Neither
  save is silent about it: MCP `doc_save` names the sections in a `note:` line
  of its reply and says to save as `.fundab` in the app, and the app shows the
  same as a notice after a `.funda` save. MCP says it once, on the save that
  left them out. A failed `doc_save` stamps nothing, because the stamp goes on
  a copy of the document that is written.
- A new reference to geometry is a lowercase hex BLAKE2b-128 string held as a
  string value, never as an object key, so an older writer finds it and keeps
  the blob. The older writer only scans values.
- A new section kind uses codec `0` or `1`, so an older version carries it.
- An older version copies such a section unchanged after the user edited the
  document, it cannot update it. So a new section kind must stay valid against
  any edit. It cannot check itself against the document section's `raw_hash`:
  an older writer always encodes the document again, with its own `version`
  stamp and key order, so that hash changes on every older save, edited or not.
  A section that describes the document should name what it depends on, such
  as feature ids, and ignore entries whose targets are gone.

## What the error correction does not cover

- Damage to more than `m` shards of one group of a section.
- Loss of both headers' views of both table copies at once.
- Silent substitution of a whole valid file: the format detects accidents, not
  an adversary. Opening a file from an untrusted source is protected by the same
  size limits and path rules as before, not by the checksums.
