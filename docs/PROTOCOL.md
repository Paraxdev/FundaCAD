# Sidecar wire protocol

The frontend and the Python geometry sidecar (`sidecar/server.py`) talk JSON over one
persistent WebSocket, `ws://127.0.0.1:8765`. It is a request/response protocol: every
request carries a client-generated `id`; every terminal reply echoes that `id`. There is
one connection per app instance; concurrent calls are matched by `id`, not by ordering.

This document describes the wire shapes as implemented in `sidecar/server.py` (the
dispatch in `handle()`) and consumed in `src/geometry/client.ts`. If the two ever
disagree, the code is the source of truth, update this file to match it, not the other
way around.

The Rust engine being ported in `crates/fundacad-engine`/`crates/fundacad-geom`
answers the exact same JSON envelope and binary frames; only the transport
differs. Its worker process (`fundacad --engine`) talks to the Tauri supervisor
over stdio, one message per `[u32 LE payload_len][u8 kind][payload]`, kind `1`
for UTF-8 JSON text and `2` for a binary reply frame, no handshake or token
(`crates/fundacad-protocol/src/stdio.rs`, and see `docs/RUST-PIVOT.md` section
2.1). `fundacad-engine --ws` also serves the WebSocket shape above, for
`npm run dev`, the e2e scripts and the differential harness. As of this branch
the Rust engine implements `rebuild`, `computeAll`, `export`, `import`, `ping`
and `cancel`; every other op still answers `{"error": {"message": "unknown op:
<op>"}}` there while its port lands (`docs/RUST-PIVOT.md`'s phase 2 list).
Where the two engines' behaviour genuinely differs rather than one simply not
being ported yet, a note says so inline.

## Connecting

The URL carries the per-launch shared secret as a query parameter:

```
ws://127.0.0.1:8765/?token=<FUNDACAD_SIDECAR_TOKEN>
```

The Rust shell mints `FUNDACAD_SIDECAR_TOKEN` per launch and hands it to the frontend via
the `sidecar_token` Tauri command; the frontend fetches it once in `Geometry.init()`
before opening the socket. A connection missing or misquoting the token, or one whose
`Origin` header isn't the Tauri webview / dev server, is closed with WebSocket close
code 1008. There is no unauthenticated mode.

## Request envelope

```jsonc
{ "id": "<client-generated string, e.g. a UUID>", "op": "<op name>", /* op-specific fields */ }
```

## Reply envelope

A **terminal** reply always has the same top-level shape:

```jsonc
// success
{ "id": "<matching id>", "ok": true, "result": { /* op-specific */ } }
// failure
{ "id": "<matching id>", "ok": false, "error": { "message": "...", "feature_id": "...", "code": "..." /* both optional */ } }
```

`rebuild` and `computeAll` additionally stream **non-terminal progress frames** with no
`ok` field, see "Progress frames" below; a client must not resolve a pending call on
one of those.

## Ops

### `rebuild`

Rebuilds the document and returns tessellated geometry. Supports two request shapes:

**Full send** (first call, or after a resync):
```jsonc
{ "op": "rebuild", "id": "...", "document": { /* CadDocument */ }, "revision": 1,
  "tolerance": 0.1, "known": { "<bodyId>": "<etag>", ... } }
```

**Delta send** (the sidecar worker already holds a document from a prior full send):
```jsonc
{ "op": "rebuild", "id": "...", "baseRevision": 1, "revision": 2,
  "ops": {
    "length": 5,               // truncate/pad the held feature list to this length
    "set": [[2, { /* feature */ }], ...],  // [index, feature] pairs that changed
    "parameters": { /* optional, only when changed */ },
    "bodyVisibility": { /* optional, only when changed */ }
  },
  "tolerance": 0.1, "known": { "<bodyId>": "<etag>", ... } }
```

`tolerance` defaults to `0.1` server-side if omitted. `known` maps body id -> the etag
of the mesh payload the client already holds, for the per-body cache described below.

Reply `result` is one of:

- **Resync needed**, the worker doesn't hold a document at `baseRevision` (first
  connection, worker respawn, or a missed message): `{ "resync": true }`. The client
  must retry with a full send.
- **Nothing built yet** (e.g. only sketches, no solid): `{ "protocol": 2, "bodies": [], "bbox": null }`,
  plus whichever of `bodyIds`/`datumPlanes`/`sketchPlanes`/`datumMarks` below apply, since
  none of those four needs a solid to resolve (a document can be nothing but datum planes).
- **Built** (protocol v2, per-body payloads, see below):
  ```jsonc
  {
    "protocol": 2,
    "bodies": [ /* one entry per live body, full payload or "unchanged" stub */ ],
    "bbox": { "min": [x,y,z], "max": [x,y,z] },
    "bodyIds": { "<feature id>:<index>": "<body id>", ... },        // optional, see below
    "diagnostics": [ /* selector resolutions worth reporting; see below */ ],
    "datumPlanes": { "<datumPlane id>": { "origin": [..], "normal": [..], "xdir": [..] } },
    "sketchPlanes": { "<sketch id>":     { "origin": [..], "normal": [..], "xdir": [..] } },
    "datumMarks": { "<datum id>": { "origin": [..], /* ... */ } },   // optional, see below
    "projectionUpdates": [ /* the lenient sibling of projectGeometry; see below */ ],  // optional
    "featureError": { "message": "...", "feature_id": "...", "code": "..." },   // optional
    "featureErrors": [ { "message": "...", "feature_id": "...", "code": "..." }, ... ]  // optional
  }
  ```

  `bodyIds` is a body's id remembered against where it came from (the feature that made
  it, and which of that feature's bodies it was, `sidecar/body_ids.py`), so switching
  off, failing or reordering a feature leaves every other body's id alone; a document
  with no map yet is numbered by position, once, the same as before the map existed.
  It is present only when it changed from the document's own `bodyIds`, and the
  frontend writes it straight back so the next rebuild sees the same ids again.
  `datumMarks` is `datumPlanes`'s sibling for datum axes and points that
  FOLLOW geometry (an axis anchored to an edge), present only for the ones that moved,
  the same fallback rule as `sketchPlanes`. `projectionUpdates` is the automatic,
  LENIENT refresh of a sketch's `"projected"` entities against `projectGeometry`'s
  cached sources; it rides along only when the refresh found a real change, and unlike
  `projectGeometry` itself it never refuses an ambiguous match outright, it keeps the
  last good shape and flags the entity stale instead.

  `datumPlanes` and `sketchPlanes` say where the build actually PUT each plane, for
  features anchored to a body face. The feature's own `plane` is the cache written at
  pick time, and once the face moves the two part company, so a client that draws from
  the cache draws the sketch at the old position while the geometry cut from it lands
  at the new one. `datumPlanes` carries every datum and has its `offset` already
  applied; `sketchPlanes` carries only the sketches that MOVED, so an absent id means
  the cache is still right. Both are display state and are never written back into the
  document.
  `featureError`/`featureErrors` are present only when one or more features failed and
  were recorded as no-ops; the geometry that *did* build is still returned (a failing
  feature never blanks the whole model). `featureError` is the most-downstream failure,
  for a single-line banner; `featureErrors` carries all of them.

  `diagnostics` is omitted when empty, but when present it is **complete for the whole
  document**, an incrementally-resumed rebuild replays the diagnostics of its cached
  prefix rather than reporting only the features it re-ran. Clients may rely on that:
  the "Re-pick face" repair is offered only when the build carries a repairable entry,
  so a partial array would silently withdraw a repair path on exactly the documents
  that need it. (Before 0.1.70 the array *was* partial, a resumed build re-reported
  every error with zero diagnostics.)

  A diagnostic may carry a machine-readable **`code`** beside its human `reason`:
  `ambiguousReference` (the selector matched several candidates), `referenceNotFound`
  (it matched nothing), `planeTilted` (a face-anchored plane's face is no longer
  parallel, so the plane kept its cached placement) and `sealedVoid` (a Cut closed a
  cavity inside a body instead of reaching its surface). Adding a code is a pure addition,
  an unrecognised one must read as "unclassified", and the prose match on `ambiguous
  nearest pick` is still honoured, so a sidecar older than the field keeps its repair
  affordance. The first two are repairable by picking a face; `planeTilted` is not,
  because the candidate filter is taken against the cached normal and re-picking the
  same tilted face reproduces the same diagnostic; neither is `sealedVoid`, which
  describes a RESULT rather than a resolution and has no reference to re-pick.
- **Fatal**, nothing built at all: `{ "error": { "message": "...", "feature_id": "..." } }`.
- **Stalled worker**, one operation ran past the stall timeout (60 s of no build
  progress): the sidecar kills and respawns the geometry worker and returns
  `{ "error": { "message": "one operation stalled for over N s, the geometry kernel was restarted; progress up to the last checkpoint is kept" } }`.
  The Rust engine has no pool to kill, so it answers the same way and abandons
  the job thread, which keeps its wedged call and never takes another job, while
  a fresh thread takes the queue. Ops with a bounded cost keep a wall clock
  instead (25 s, 180 s for `generateShape`) and answer
  `{ "error": { "message": "operation timed out, geometry too complex or degenerate" } }`.
- **Crashed worker**: `{ "error": { "message": "the geometry kernel crashed on this operation" } }`.

#### Per-body payload (protocol v2)

Each entry in `bodies` is either an **unchanged stub**:
```jsonc
{ "id": "b1", "name": "Body1", "etag": "3f9a...", "unchanged": true }
```
or a **full payload**, when the client's `known` etag for that body is stale or absent:
```jsonc
{
  "id": "b1", "name": "Body1", "etag": "3f9a...",
  "positions": [ /* flat float array, xyz per vertex */ ],
  "normals": [ /* flat float array, one per vertex; omitted, not null, when the tessellator kept none */ ],
  "indices": [ /* flat triangle index array */ ],
  "faceIds": [ /* per-triangle face id, local to this body */ ],
  "faceOwners": [ /* per-face owner id or null, for feature highlighting */ ],
  "edges": [ { "points": [...], "body": "b1", "smooth": true } ],  // "smooth" present only when the edge's two faces meet tangentially
  "faceCount": 12
}
```
`nodeRef` (an imported part's `"<import feature id>/<manifest node index>"`),
`faceColors` (a packed per-face colour string) and `partColor` (a whole-body hex
colour) are optional envelope fields that can appear on EITHER shape, stub or full,
since a body's own mesh not changing does not mean its colouring didn't; they are
kept out of the etag below for the same reason.

The client (`Geometry.assemble()` in `src/geometry/client.ts`) keeps the last full
payload per body id and merges stubs + full payloads into one flat mesh (vertex/index/
faceId offsets rebased per body), reproducing the pre-v2 single-mesh `RebuildReply`
shape for the rest of the app. If a stub's etag doesn't match anything the client is
holding (e.g. state lost across a worker respawn), `assemble()` returns `null` and the
client resyncs with one full request.

`etag` only ever needs to compare equal, its VALUE carries no meaning to the client,
but the two engines mint it differently. The Python sidecar hands out a random one per
cache entry (`uuid4().hex`); the Rust engine hashes the payload itself (blake2b-128 of
`positions`/`normals`/`indices`/`faceIds`/`edges`, 32 hex digits, envelope fields like
`id`/`name`/colours excluded), so identical geometry gets the same etag even across a
worker restart that emptied every cache, not just within one running worker's.

### `computeAll`

MCAD-style "Compute All": bypasses every cache layer (the sidecar's RAM prefix cache,
mesh cache, and disk checkpoints/blobs) before doing one cold full rebuild. Always a
full send, never a delta:

```jsonc
{ "op": "computeAll", "id": "...", "document": { /* CadDocument */ }, "revision": 2, "tolerance": 0.1 }
```

Reply shape is identical to `rebuild`'s built/fatal cases above (protocol v2, no
resync case since this is always a full send). Streams the same progress frames.

### `export`

Rebuilds (from the warm in-worker cache, not a cold rebuild) and writes one file.

```jsonc
{ "op": "export", "id": "...", "document": { /* CadDocument */ },
  "format": "step" | "stl" | "3mf" | "glb",
  "path": "/abs/path/out.step", "body": "<bodyId>", "separate": false,
  "palette": [ { "color": "#rrggbb" }, ... ],    // optional, GLB per-body colour slots
  "bodyColors": { "<bodyId>": 0 },               // optional, body id -> palette index, GLB only
  "mesh": { "surfaceDeviation": 0.02, "normalDeviation": 17.2,
            "maxEdgeLength": 0, "unit": "mm", "binary": true } }   // optional
```

`body` (export just one body) and `separate` (write every live body to its own file, in
a NEW SIBLING FOLDER named after `path`'s own stem, not `<base>-<name>.<ext>`) are
optional. `palette`/`bodyColors` matter only for `glb`: a body absent from
`bodyColors`, or given an out-of-range index, falls back to palette slot `0` if one
exists, else no colour override. `mesh` fields are each independently clamped rather
than rejected: `surfaceDeviation` mm in `[1e-4, 10]` (default `0.02`, the largest gap
between the body and a facet), `normalDeviation` degrees in `[0.5, 90]` (default about
`17.2`, i.e. `0.3` rad, the largest angle between neighbouring facets), `maxEdgeLength`
mm in `[0, 1e6]` (`0` disables the post-pass), `unit` one of `mm|cm|m|in|ft` (default
`mm`, divides mesh-format positions only, STEP always writes native millimetres), and
`binary` (default `true`, STL only, 3MF and GLB have no ASCII form). STL, 3MF and GLB
are all hand-rolled writers on both engines, not an OCCT/build123d exporter, so a
plugin-textured body's per-face colour survives on those three formats; STEP goes
through XCAF (`STEPCAFControl_Writer`), which is why textured bodies lose their surface
detail there (see the warning below). The Rust engine's STEP writer additionally stamps
the file's `FILE_NAME` originating-system field as `"FundaCAD"`; the Python path leaves
OCCT/build123d's own default.

Reply:

```jsonc
{ "path": "/abs/path/out.step" }                       // default / single-body
{ "path": "/abs/path/out", "paths": ["...", "..."] }   // separate: "path" is the new FOLDER
{ "path": "...", "warnings": [{ "message": "...", "feature_id": "...", "code": "..." }] }
```

Export is "export what built": a feature failure never blocks exporting the bodies that
did build; only zero live bodies is a hard `{ "error": {...} }`. A `warnings` entry can
also carry no `feature_id` at all, raised by the export itself rather than by a
feature: STEP export with a plugin-displaced (textured) body present ("surface
displacement from a plugin is not represented in STEP exports"), or a mesh export past
500,000 triangles but under the 10,000,000-triangle hard cap ("export is very dense (N
triangles)"); past the hard cap it is instead a hard `{ "error": {...} }` naming the
count. `separate` into a folder that already exists is also a hard error naming it.

### `exportWith`

Rebuilds, meshes every live body at export grade (with the same triangle budget as
`export`), and hands the meshes to an exporter a plugin registered with
`plugin_geometry.register_exporter`. What the file looks like is the plugin's.

```jsonc
{ "op": "exportWith", "id": "...", "document": { /* CadDocument */ },
  "path": "/abs/path/out.ext",
  "exporter": "<name the plugin registered>",
  "options": { /* passed to the exporter verbatim, capped at 256 KiB JSON */ } }
```

A missing or overlong `exporter`, or `options` failing the size/type check, replies
`{ "error": { "message": "exportWith: bad exporter" } }` (or `bad options`) before any
rebuild runs. An exporter no installed plugin provides is an error naming it.
Otherwise the reply matches `export`'s shape (`path` + optional `warnings`), plus an
optional `info` object the exporter chose to report.

Plugin geometry runs in the Python worker today, with full worker privileges and no
sandbox. In the Rust engine it moves into WebAssembly components inside each plugin
(`docs/RUST-PIVOT.md` section 2.3); until that host exists the Rust engine answers this
op `unknown op`.

### `interference`

Pairwise interference (clash) check among the document's live bodies. Display
only: the result never enters the document or undo history.

```jsonc
{ "op": "interference", "id": "...", "document": { /* CadDocument */ },
  "clearance": 0.2 }   // optional, mm: turns on the near-miss pass below
```

Reply:
```jsonc
{ "pairs": [
    { "a": "<bodyId>", "b": "<bodyId>", "aName": "...", "bName": "...",
      "volume": 12.34, "bbox": { "min": [x,y,z], "max": [x,y,z] },
      "positions": [...], "indices": [...] }   // coarse overlap-solid mesh, omitted if untessellatable
  ],
  "clearances": [   // only present when "clearance" was given
    { "a": "<bodyId>", "b": "<bodyId>", "aName": "...", "bName": "...",
      "distance": 0.1, "pointA": [x,y,z], "pointB": [x,y,z] }
  ],
  "truncated": true, "message": "..."   // only present if the candidate-pair cap was hit
}
```
`pairs` has one entry per pair whose boolean intersection volume exceeds a small
epsilon; `positions`/`indices` are a display-tolerance triangulation of the
overlap solid itself, for drawing it as a highlight, not exported geometry.
`clearances` has one entry per pair that does NOT overlap but comes within
`clearance` mm of each other, with the exact distance and one nearest point on
each body. A cheap bounding-box reject (widened by `clearance` when given)
skips most pairs before the (crashable) boolean intersection or exact-distance
call runs; the real per-pair work (a boolean or a distance search) is capped at
`_MAX_INTERFERENCE_OPS` (400) candidate pairs, past which the sweep stops and
reports `truncated`/`message` rather than running unbounded on a dense
assembly. `clearance` omitted or 0 skips the near-miss pass entirely, callers
that never asked for it pay nothing extra.

### `inspect`

Exact B-rep measurements of the document's live bodies. Rebuilds through the same
warm cache `export` and `interference` use, so asking what a model measures right
after building it costs a cache hit rather than a second rebuild.

```jsonc
{ "op": "inspect", "id": "...", "document": { /* CadDocument */ },
  "detail": true,          // omit the per-face/per-edge lists with false
  "bodies": ["body1"],     // optional: only these body ids (or names)
  "maxFaces": 400, "maxEdges": 800 }
```

Reply:
```jsonc
{ "bodies": [ {
    "id": "body1", "name": "Body1",
    "volume": 6283.19, "area": 1884.96, "centerOfMass": [x,y,z],
    "bbox": { "min": [...], "max": [...], "size": [...] },
    "faceCount": 3, "edgeCount": 3, "solidCount": 1,
    "faces": [ { "i": 0, "surface": "cylinder", "area": 1256.64,
                 "centroid": [...], "normal": [...], "point": [...],
                 "radius": 10.0, "axis": [0,0,1], "wraps": true,
                 "neighbors": [1,2],
                 "selector": { "kind":"face", "by":"match", "fp": {...}, "body":"body1" } } ],
    "edges": [ { "i": 1, "curve": "line", "length": 20.0, "mid": [...], "dir": [...],
                 "faces": [0,0], "seam": true, "openBoundary": true,
                 "selector": { "kind":"edge", "by":"match", "fp": {...}, "body":"body1" } } ],
    "truncated": { "faces": 0, "edges": 0 }   // only when a cap was hit
  } ],
  "errors": [ { "message": "...", "feature_id": "..." } ] }
```

Three fields are not measurements and matter more than the measurements:

- **`selector`** on every face and edge, authored by `geom_select`'s own
  fingerprint functions. A caller that has never clicked on anything can address
  the geometry it just read about.
- **`point`** is the centroid PROJECTED onto the face, so it genuinely lies on it.
  A washer's flat face has its centroid in the hole, and `by:"nearest"` scores by
  true point-to-surface distance.
- **`seam`** on an edge whose two ancestor faces are the SAME face, and `wraps` on
  a face that closes on itself. Those are exactly the edge a blend refuses and the
  face a linear press/pull has no direction for. An edge with fewer than two
  ancestor faces (a mesh-import border, or a body whose shell doesn't close) carries
  `openBoundary` instead.

Failing features are REPORTED in `errors`, not raised: a document with one red
feature still has bodies, and looking at what did build is the point.

Face indices `i` are positions in the body's `shape.faces()`, the same numbering
the tessellator and the frontend's face ids use.

### `projectGeometry`

Projects edges, whole face boundaries, sketch curves or a body's silhouette onto a
plane, for a sketch's `"projected"` entities. Rebuilds through the same warm cache as
`export`/`interference`/`inspect`. This is the STRICT sibling of `rebuild`'s own
automatic projection refresh (`projectionUpdates`, above): a source this op cannot
match exactly is refused outright, per source, rather than resolved with a guess.

```jsonc
{ "op": "projectGeometry", "id": "...",
  "document": { /* CadDocument, truncated to the prefix before the sketch that holds the projection */ },
  "plane": "XY" | "<datumPlane featureId>" | { "origin": [..], "normal": [..], "xdir": [..] },
  "sources": [
    { "kind": "edge", "body": "<bodyId>", "sel": { /* Selector */ } },
    { "kind": "faceBoundary", "body": "<bodyId>", "sel": { /* Selector */ } },
    { "kind": "sketchCurve", "sketch": "<sketchFeatureId>", "entity": "<entityId>" },
    { "kind": "silhouette", "body": "<bodyId>" }
  ] }   // "sources" optional, default []
```

Reply:
```jsonc
{ "results": [
    { "source_index": 0, "ok": true, "curves": [ { "fp": {...}, "curve": {...} } ] },
    { "source_index": 1, "ok": false, "curves": [], "error": "the source geometry no longer exists on the body" }
] }
```
`fp` (a `geom_select` fingerprint) is present only for `edge`/`faceBoundary` sources.
`curve` is one of four shapes, exact where exactness survives projection (a circle
whose axis stays parallel to the plane normal stays a circle) and sampled to a poly
otherwise: `{"kind":"line", "x1":..,"y1":..,"x2":..,"y2":..}`,
`{"kind":"circle", "x":..,"y":..,"r":..}`,
`{"kind":"arc", "x1":..,"y1":..,"x2":..,"y2":..,"mx":..,"my":..}`,
`{"kind":"poly", "pts":[[x,y], ...]}`. A whole-request failure (a bad plane spec, a
prefix rebuild that fails outright) is `{ "error": { "message": "..." } }`; per-source
failures never raise, they land in that source's own `results[i]` instead.

### `import`

Reads an external geometry file into a blob-stored shape for an `import` feature.
Path-based, the sidecar/engine reads the file directly, the frontend never ships file
bytes over the socket. Formats: `step`/`stp`, `brep`, `stl`, `3mf`, `obj`, `glb`.

```jsonc
{ "op": "import", "id": "...", "path": "/abs/path/in.step", "format": "step" }
```

Reply:
```jsonc
{
  "geom": "<blob store content hash>",
  "solid": true,
  "faces": 6,
  "name": "MyPart",
  "color": "#rrggbb",          // omitted, not null, when the file carries no colour
  "nodes": [ { "name": "...", "parent": 0, "color": "#rrggbb" }, ... ],  // STEP assemblies only
  "parts": [ { "node": 0, "faces": 12, "faceColors": "<packed>", "color": "#rrggbb" }, ... ]  // STEP assemblies only
}
```
or `{ "error": { "message": "..." } }`. `geom` is a content hash into the durable blob
store, not inline geometry, and `faces` is the shape's total face count, an integer,
not a list. (An older document's `import` feature may still carry a legacy `brep`
field, inline base64 BREP from before the blob store existed; a feature's own read
prefers `geom` but falls back to `brep`, and a fresh `import` reply never writes `brep`
again, `migrateGeometry` below one-way upgrades an old one.) Given a longer budget than
a normal rebuild (mesh read + B-rep build can run longer).

Both engines peek the file's own reported triangle count and refuse past 150,000 for
STL/3MF, and past the same count once parsed for OBJ, before building any B-rep. GLB
import additionally refuses a file whose glTF keeps geometry in a buffer other than the
embedded one ("this glTF keeps its geometry in an external buffer, only a
self-contained .glb imports"): `RWGltf_CafReader`, the Python path's OCCT reader, would
otherwise happily resolve an external buffer, but the Rust engine's hand-written GLB
reader only ever looks at the embedded BIN chunk. STL/3MF/OBJ import has no OCCT reader
binding in either engine's plan (`docs/RUST-PIVOT.md` section 4.1); the Rust engine
parses these formats itself, the same "OCCT doesn't help here" precedent the export
side's mesh writers already set.

### `migrateGeometry`

A one-way, opportunistic upgrade the FRONTEND calls on document open, not tied to any
feature-tree rebuild: turns an `import` feature's legacy inline base64 `brep` field
into a blob-store `geom` hash. Skipping it is safe and idempotent, `import`'s own read
already prefers `geom` and falls back to `brep` forever, so a document that never gets
migrated just keeps paying the inline-base64 size cost.

```jsonc
{ "op": "migrateGeometry", "id": "...",
  "items": [ { "id": "<featureId>", "brep": "<base64>" }, ... ] }   // "items" optional, default []
```

Reply:
```jsonc
{ "items": [ { "id": "<featureId>", "geom": "<blob store content hash>" }, ... ],
  "failed": [ { "id": "<featureId>", "message": "..." } ] }
```
Per-item failures are REPORTED in `failed`, never raised: one unreadable legacy body
must not block migrating the rest, and the document keeps its inline copy for anything
that fails either way. Runs in the worker process deliberately: this parses geometry
out of a file the user opened, which may be hostile, in a process whose crash does not
take anything important with it.

### `generateShape`

Runs a shape generator a plugin registered (`plugin_geometry.register_shape_generator`) on plain JSON
parameters, outside any document.

```jsonc
{ "op": "generateShape", "id": "...", "generator": "fastener", "params": { ... },
  "output": "mesh",                                           // or "store"
  "placement": { "origin": [0, 0, 0], "zAxis": [0, 0, 1] } }  // optional
```

Reply: `{ "solid": true, "solids": 1, "valid": true, "faces": 20, "volume": 132.2,
"bbox": { "min": [...], "max": [...] } }` plus, for `mesh`, `"mesh": { "positions", "indices",
"normals" }` (flat arrays, one normal per position) and, for `store`, `"geom"`: the blob store hash
an `import` feature carries. An unknown generator, a generator's ValueError, a bad placement or a
result with no solid is `{ "error": { "message": "..." } }`. Budget 180 s, a modelled thread on a
long bolt is thousands of helical faces. Like `exportWith`, this is plugin geometry: the
Rust engine answers `unknown op` until its wasm plugin host exists (`docs/RUST-PIVOT.md`
section 2.3).

### `tessellateText`

A sketch `text` entity's glyph outlines, for the sketch editor's live preview, without
building a solid.

```jsonc
{ "op": "tessellateText", "id": "...",
  "entity": { "type": "text", "text": "Hi", "height": 5, "style": "regular",
              "align": "left", "angle": 0, "font": "Arial", "x": 0, "y": 0,
              "boxWidth": 40, "positionOnPath": 0.5 },
  "pathEntity": { /* optional line/arc/circle/spline entity, a text-on-path anchor */ } }
```

Reply: `{ "faces": [ { "outer": [[x,y], ...], "holes": [ [[x,y], ...], ... ] }, ... ] }`,
one entry per glyph FACE (a glyph with one counter, like "o", is one face with one
hole; a glyph with two, like "B", is one face with two holes). Every coordinate is
already in FINAL sketch-2D space, anchor, rotation, alignment and path placement all
applied, so the preview's face count matches the extruded solid's exactly, both call
the same helper. On any failure: `{ "error": { "message": "..." } }`; a font/glyph
failure that does not raise instead answers `{ "faces": [] }`, not an error.

### `listFonts`

No request fields beyond the envelope.

```jsonc
{ "op": "listFonts", "id": "..." }
```

Reply: `{ "families": [...] }`, a sorted, deduplicated list of font family names, never
file paths or style variants. Never errors to the caller: an unreadable font, or a
machine with nothing usable, just answers `{ "families": [] }`. The Python sidecar
reads this from OCCT's `Font_FontMgr`; the Rust engine's port is planned to read it
from `fontdb`'s own system font discovery instead, `Font_FontMgr` is deliberately not
carried forward at all (`docs/RUST-PIVOT.md` section 2.3), keeping the same observable
contract: sorted, deduplicated, never an error.

### `session_*`, the live session

Five ops that share one document between the app window and an outside client
(the MCP server in `crates/fundacad-mcp/tools/python-oracle/`). They are answered on the **read path**, never behind
the heavy-op lock: the window publishes on a loop, and a publish that queued
behind a rebuild would make the window invisible to an agent for exactly as long
as the agent's own build took. The rules, and why they are these rules, are in
`sidecar/live_session.py`.

One **host** (the window) owns the document and is the only thing that may raise
its revision. Any number of **guests** may read it and propose a replacement.
The connection is the identity: whoever holds the socket holds the role, and
losing the socket gives it up.

```jsonc
// the window, on its loop: publish what is open, collect what has been asked for
{ "op": "session_host", "id": "...", "document": { /* CadDocument */ },
  "revision": 12, "title": "spool.funda",
  "status": { "canEdit": true, "applied": ["p3"], "building": false } }
// -> { "ok": true, "guests": ["an assistant"], "proposals": [ { "id": "p4",
//      "name": "an assistant", "note": "feature_add: cylinder",
//      "baseRevision": 12, "document": { ... } } ] }

// the window, on the way out. Takes the document with it: a document with no
// host is not one anyone may act on.
{ "op": "session_release", "id": "..." }          // -> { "ok": true }

// a guest reading. Also its heartbeat, which is why the name is on a READ.
{ "op": "session_state", "id": "...", "name": "an assistant" }
// -> { "attached": true, "revision": 12, "title": "...", "status": { ... },
//      "document": { ... }, "guests": [...] }

// a guest offering an edit
{ "op": "session_propose", "id": "...", "document": { ... }, "baseRevision": 12,
  "note": "feature_add: cylinder", "name": "an assistant" }
// -> { "ok": true, "proposal": "p4", "revision": 12 }
// -> { "ok": false, "reason": "stale" | "no-host" | "backlog",
//      "revision": 14, "message": "..." }

{ "op": "session_leave", "id": "..." }            // -> { "ok": true }
```

A proposal is refused if `baseRevision` is not the current revision. That is the
rule that stops an agent's edit landing on a model the user has since changed,
the selector it wrote may now address a different face. Three named reasons
rather than one failure, because the guest's next move differs for each: give
up, read again, or wait.

`status` is opaque to the sidecar and is passed through verbatim. The window puts
`canEdit` in it (so a guest refuses an edit up front instead of waiting out its
own timeout) and `applied`, the ids of the proposals it has taken, which is the
acknowledgement a guest waits on. Not "the revision moved", which also moves for
the user's own edits, and not "the published document equals what I offered",
which is never true: the window migrates a document on the way in and adds
`version`, `suppressed` and the visibility overlays on the way back out.

### `cancel`

Answered on the read path, ahead of any op queued behind the heavy-op lock, so it is
heard WHILE a job runs rather than queued after it, the entire point (a slow import or
rebuild can hold the worker a long time, and cancelling it has to interrupt that, not
wait for it).

```jsonc
{ "op": "cancel", "id": "...", "target": "<request id>" }   // "target" optional
```

Reply: `{ "cancelled": true }` if something was actually stopped, `{ "cancelled": false }`
if nothing was running, or `target` named a request that had already finished (a race
between the click and the job completing must not cancel a different, unrelated job
that started meanwhile). Omitting `target` cancels whatever is currently running.
Neither engine can interrupt a running kernel call any other way, so a cancel not
honoured within a grace period kills and respawns the worker process (the Rust engine
on `--ws`, which nothing supervises, abandons its job thread instead); the operation it
was running then answers `{ "ok": false, "cancelled": true, ... }` rather than the
generic "the geometry kernel crashed on this operation" reply, so the caller can tell a
deliberate cancel apart from a real crash.

### `ping`

Liveness check with no side effects: `{ "op": "ping", "id": "..." }` -> `{ "pong": true }`.

### Unknown op

Any other `op` value replies `{ "error": { "message": "unknown op: <op>" } }`.

## Progress frames

During a `rebuild` or `computeAll`, the sidecar sends interim frames on the same
connection, reusing the request's `id` but with **no `ok` field**:

```jsonc
{ "id": "<same id as the request>", "status": "building", "feature": 3 }
```

`feature` is the index of the feature currently being built, or `-1` while
tessellating. `meshed` / `meshTotal` carry the payload phase's per-body denominator
(both `-1` outside it), so a client can say "meshing 812/3071" rather than sitting at
0% for the whole phase. These fire roughly once a second during a long rebuild. An
`import` streams the same way with `status: "importing"` and `phase` / `label` / `pct`.

A client must route **any** frame carrying a `status` string to its progress listeners
and never treat one as the terminal reply, the real `{ "ok": ... }` reply always
follows once the rebuild finishes (or the worker is judged stalled/crashed, per the
`rebuild` error cases above). Guarding on `status === "building"` alone is a trap: an
unrecognised status then falls through to the pending-request map and resolves the
caller with a frame carrying no `ok`, so the caller reports failure while the sidecar
happily keeps working.

## Binary mesh frames (`"binary": true`)

`rebuild` and `computeAll` accept `"binary": true`, which moves the per-body mesh arrays
out of the JSON header and into raw little-endian buffers appended to the same frame:

```
[u32 LE header_len][header_len bytes UTF-8 JSON header][pad to 4][buf0][buf1]...
```

The header is the normal `{"id","ok","result"}` envelope, except each mesh array
(`positions`/`normals` → f32, `indices`/`faceIds` → u32) is replaced by `{"$buf": i}`
referencing `result.$buffers[i] = {"dtype","len"}` (`len` is an **element** count) in
on-wire order; the client walks `$buffers` to compute offsets sequentially. A body's
edge polylines are packed the same way into `{"$pts","$counts","body"}`, where `$counts`
holds each edge's **point** count. Everything else, stubs, `faceOwners`, `bbox`,
`diagnostics`, stays inline JSON in the header.

Both dtypes are 4 bytes/element, so after the single header pad every buffer is
4-aligned for free. **INVARIANT: adding a wider dtype requires per-buffer padding.**

## Chunked replies (`"chunked": true`)

A successful `rebuild`/`computeAll` mesh reply can exceed any single frame the socket
will carry (`_MAX_FRAME`, 128 MiB, a DoS control, mirrored in `client.ts` as
`MAX_MESSAGE_BYTES`). `"chunked": true` (which also requires `"binary": true`) splits
the reply across several frames instead, so document size stops being a hard limit.

Each chunk is a **self-contained binary frame** in exactly the layout above, its own
header, its own pad, its own `$buffers` table. Buffer indices are therefore **frame-local**
and each chunk decodes independently. The framing rides in one extra envelope field:

```jsonc
{ "id": "<request id>",
  "stream": { "sid": "<per-reply id>", "seq": 0, "final": false },
  "status": "chunk",          // NON-final frames only
  "ok": true,                 // the FINAL frame only
  "result": { /* ... */ } }
```

- **`seq: 0` (the head)** carries every non-body field (`protocol`, `bbox`, `bodyIds`,
  `diagnostics`, `datumMarks`, `projectionUpdates`, `featureError(s)`) plus a
  **`manifest`**: one entry per body of the reply, in final order, as
  `{id, name, etag, nodeRef?, faceColors?, partColor?, unchanged?}` plus
  `{faceCount, nVerts3, nIdx, nTris, nEdges, hasNormals?}` **for full bodies only**.
  Sizes are absent on stubs by design, the sidecar does not have them, because those
  arrays live in the client's own per-body cache. The head carries no `bodies`.
- **`seq: 1..N`** each carry a contiguous slice of `bodies` (plus its `$buffers`), in
  manifest order. Order is load-bearing: the client accumulates each body's global
  `faceStart` by it, and face picking keys off those ranges.
- The **final** frame carries `ok: true` and `stream.final: true` and no `status`; it is
  what resolves the request.

A client must treat the stream as complete only when `final` is set, `seq` arrived dense
from 0, and the accumulated body count equals the manifest length. The count check is
load-bearing rather than defensive: `assemble()` prunes its per-body cache to the ids it
was handed, so silently accepting a short stream would evict the missing body and corrupt
the *next* rebuild's `known` map too.

Two invariants a client may rely on, neither of them local to the sending code:

- **Streams never interleave.** `_serialized` holds its lock across the whole of
  `_dispatch`, including every send.
- **No `building` frame lands mid-stream**, even though it shares the request `id`: the
  worker has already returned before the first chunk goes out.

Chunking is **binary-only**. There is deliberately no JSON-text chunk form: a text frame
carrying `status` is routed to progress listeners and dropped.

Negotiation is per request, exactly like `binary`. An older sidecar ignores the unknown
flag and answers with one frame; an older client never sets it and gets one frame. So
neither side can emit a stream the other cannot read. When the flag *is* set, every
successful mesh reply is streamed, not just large ones, so the multi-frame path is
exercised constantly rather than for the first time on a user's oversized assembly.

Two cases still end a reply with a terminal **text** error, which supersedes any partial
stream: a cancel arriving between chunks (`{"ok": false, "cancelled": true, ...}`), and a
**single body** whose own payload exceeds the frame cap, the one case chunking cannot
fix, since a body is the indivisible unit of a chunk. That error names the offending body.

## Bad input

Malformed JSON on the socket gets `{ "id": null, "ok": false, "error": { "message": "bad JSON: ..." } }`
(no request `id` to echo). Any exception raised while handling a request is caught and
turned into `{ "id": "...", "ok": false, "error": { "message": "<exception text>" } }`
rather than dropping the connection.
