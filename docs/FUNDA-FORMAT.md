# The .funda file format, version 2

A `.funda` file holds one FundaCAD document and the geometry it references. From
version 2 it is a binary file that finds and repairs damage to itself: every part
of it carries a checksum, every section carries Reed-Solomon parity, and the index
that locates the sections is stored twice.

The reference writer and reader is `src-tauri/src/fnda.rs`. This document is the
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
| 10 | 2 | minor | `0` |
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
| 1 | kind | `0` info, `1` document, `2` geometry, `3` mesh |
| 1 | codec | `0` raw, `1` deflate |
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

## Writing

1. Write 64 zero bytes as a placeholder header.
2. For each section: encode the raw bytes with its codec, hashing the raw bytes
   with BLAKE2b-128 as they pass; cut, compute parity, write the groups and then
   the CRC table.
3. Write the table twice, then the trailer.
4. Seek to 0 and write the header.

The writer builds the file at a temporary path beside the target, flushes it to
stable storage, and renames it over the target, so a crash leaves the old file
or the new one and never a torn one.

Layouts FundaCAD uses, chosen per section:

| Sections | shard_size | k | m | Overhead | Repairs per group |
|---|---|---|---|---|---|
| info, document | 4 KiB | 8 | 4 | 50% | any 4 of 12 shards |
| geometry, mesh | 64 KiB | 32 | 4 | 12.5% | any 4 of 36 shards |

A reader must accept any layout within the limits in the table above.

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

## Older formats

FundaCAD still reads every format it has written:

- **Format 1**: a ZIP archive (first bytes `PK`) holding `manifest.json`,
  `document.json` and `geom/<hash>.bbrep`, verified by hash but with no repair.
- **Plain JSON**: a document saved before containers existed.

Only format 2 is written.

## What the error correction does not cover

- Damage to more than `m` shards of one group of a section.
- Loss of both headers' views of both table copies at once.
- Silent substitution of a whole valid file: the format detects accidents, not
  an adversary. Opening a file from an untrusted source is protected by the same
  size limits and path rules as before, not by the checksums.
