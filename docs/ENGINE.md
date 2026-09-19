# The Funda Engine

The Funda Engine is FundaCAD's geometry engine: Rust, OpenCASCADE 7.8.1
statically linked, built into the same executable as the app. It ships as
`main`'s rolling 1.0 alpha. The sidecar, the previous engine, lives on the
`legacy` branch, which keeps publishing the beta.

Related: [ARCHITECTURE.md](ARCHITECTURE.md) (what exists today),
[PROTOCOL.md](PROTOCOL.md) (the wire contract the engine honours),
[FUNDA-FORMAT.md](FUNDA-FORMAT.md), the document format, [PLUGINS.md](PLUGINS.md).

## 2. Target architecture

### 2.1 Processes

```
fundacad (Tauri main process)          fundacad --engine (worker process)
  webview: Vue + three.js                 fundacad-engine: op dispatch, job
    |  invoke + ipc::Channel                lock, cancel, progress, caches
  engine.rs: supervisor  <== stdio ==>    fundacad-geom: OpenCASCADE 7.8.1
    spawn, restart, cancel, relay           (static, in the binary)
  fnda.rs, container.rs, plugins/*
```

- **The engine runs in a worker process, the same executable started with
  `--engine`.** OpenCASCADE aborts and segfaults on bad input (offsets, blends,
  degenerate booleans) and some of its algorithms cannot be interrupted. In
  the Tauri process that would take the window and the unsaved document with
  it. A worker keeps that isolated: a crash restarts the engine and the app
  reports it, a cancel that the kernel does not honour within a grace
  period kills and respawns the worker. No extra port or token for the
  app's own traffic, it is the same executable, and only the external
  transports below need one, one binary to sign and ship.
- **Frames are unchanged.** A request is the JSON envelope of PROTOCOL.md, a
  reply is the existing binary frame (`[u32 header_len][JSON header][pad][f32
  and u32 buffers]`, chunked per body), and progress and chunk frames keep
  their shapes. Over stdio each frame gets a `u32` length and a one-byte kind.
  The frontend's frame decoder in `client.ts` reuses it as is.
- **Webview transport is Tauri IPC.** One `engine_request` command takes the
  request and an `ipc::Channel`; the supervisor relays every frame for that
  request id to the channel as raw bytes (`InvokeResponseBody::Raw`, no JSON
  or base64 on the way). `engine_cancel` takes a request id.
- **A WebSocket transport stays, outside the shipped window's path.**
  `fundacad-engine --ws` serves the same frames on 127.0.0.1 with the existing
  token and Origin gate. It is what `npm run dev` in a plain browser and the
  Playwright e2e scripts use. The MCP live session reaches a running app
  through a loopback endpoint with the same gate that the WORKER opens beside
  its stdio pipe (`FUNDACAD_LIVE_TOKEN` from the app, `LISTENING <port>` back
  on stderr), serving the same engine and so the same live session; the main
  process publishes it in `session.json`. No relay: a guest's frames never
  pass through the window.
- **Worker state.** The in-memory prefix and mesh caches live in the worker
  and are lost on a restart; the blob store is on disk and survives.

### 2.2 Crates

One Cargo workspace at the repository root.

```
crates/
  fundacad-protocol  frames: envelope, binary buffers, 16 MiB chunking,
                     progress and chunk frames, stdio framing, cancel token.
  fundacad-core      document schema (serde names equal src/types.ts),
                     parameters and expressions, migrations, body ids, face
                     colours, pattern expansion, region detection, hole
                     standards. No kernel.
  fundacad-geom      the engine on OpenCASCADE: timeline replay, feature
                     handlers, selectors, blends, booleans, tessellation,
                     import and export, caches, plugin host.
  fundacad-engine    the worker: op dispatch, job lock, cancel, stall
                     watchdog, stdio and WebSocket transports, live session.
  fundacad-format    fnda.rs, container.rs, json_doc.rs, shared by the
                     engine, the CLI and the app.
  fundacad-mcp       the MCP server on rmcp, part of the app (docs/MCP.md).
  fundacad-cli       headless rebuild/export/inspect for CI and evals.
src-tauri/           the app. engine.rs is the supervisor and IPC relay,
                     `--engine` dispatches into fundacad-engine.
third_party/opencascade-rs   vendored bindings (own workspace), extended
                     bridge by bridge as the engine needs classes.
```

Kernel: OpenCASCADE 7.8.1, compiled statically from the `occt-sys` crate the
vendored bindings pull in (no system OpenCASCADE on any platform, one C++
toolchain at build time). The sidecar ran OCCT 7.9.3 through its own
bindings, so results can differ in the last digits from its frozen answers;
the golden checks (section 5.1) compare with tolerances, not bytes.
Upgrading to upstream opencascade-rs 0.3 and later to OCCT 8.0 is tracked,
not a prerequisite.

### 2.3 Design decisions

- **Crash isolation:** a supervised worker process for the whole engine
  (section 2.1), not a child per risky operation. It makes cancel-by-kill
  uniform, and a pipe copy of a mesh is cheap next to tessellating it. Offset
  Face and Press/Pull run BRepOffset in process too: the freeform faces
  measured to crash are refused before any offset, and on OCCT 7.8.1 the
  chamfered bodies that once needed a child process refuse cleanly (128
  offsets and pushes over every face of two chamfered spools, no crash). The
  in-memory BREP round trip is kept.
- **Plugin geometry:** a plugin's geometry stays in the plugin (docs/PLUGINS.md,
  no domain logic in core). A bundle's geometry is a WebAssembly component
  the engine runs with wasmtime, built from a Rust crate inside the
  plugin folder. The engine offers a generic host API (build a solid from
  primitives and sketches, boolean, fillet, displace a face triangulation,
  read and write blobs, write an export file) and knows nothing of fasteners,
  textures or printers. The `featureTypes`, `exporters` and `shapeGenerators`
  manifest keys carry the plugin's own vocabulary, and the manifest key
  `geometryWasm` names the component; a plugin whose bundle carries only the
  beta's own manifest key runs on the sidecar alone until it ships a
  component.

#### The plugin component, in detail

The world is `crates/fundacad-geom/wit/plugin.wit`, the host is
`fundacad-geom::plugins` behind the crate feature `plugins`, which
`fundacad-cli` and `src-tauri` turn on (wasmtime and its WASI
are a large dependency tree and the default build of the geometry crate has no
use for them).

- **Exports, the four hooks:** `register` (what the component claims, checked
  against the manifest's `featureTypes`, `exporters` and `shapeGenerators`),
  `run-feature`, `resolve-pass` + `displace` with a `code-version` that rides
  in the mesh etag and the mesh cache key, `write-export`, `generate-shape`.
  `resolve-pass` hands back each claimed face with a tag that rides into its
  `displace` (a component keeps no state between calls, so what the two calls
  need to share travels there), and `displace` reads the face's stored
  triangulation, with `split-creases` on for the viewport only.
  Displaced triangles take their face's place in face order, under its id,
  with `faceColorSlots` from a spec's `colorSlot`, in the viewport (80,000
  triangles a face), the exports and `exportWith` (200,000); the payload and
  export caches key on the passes.
- **Imports, the generic kernel:** an opaque `shape` resource (never BREP
  bytes per call) with its measurements, surfaces, curves, classification and
  triangulation, its surface frame and samples of the surface at (u, v), its
  stored triangulation with the (u, v) of every node, and its orientation;
  primitives, polygon faces, line, arc and circle edges and wires, sketch
  profiles, prism, revolve, a helical sweep (a revolve that climbs), a
  rotation, booleans plain or with configurable options (parallel, a fuzzy
  value or the picked-geometry one, cleaned), unify, fillet and chamfer with
  the one-edge-at-a-time fallback, face selectors resolved against any shape,
  and the Delaunay triangulation of planar points (Qhull 2020.2, vendored in
  `third_party/qhull`, matched facet for facet against the sidecar's frozen
  output); the blob store; a feature context (the feature JSON, parameter
  values, selector picks grouped by body, body shapes in and out,
  diagnostics, mesh pass specs); `output.write` for an exporter, to a path
  the host chose; `numeric`, the engine's own C math library, so a plugin's
  sines and powers round the same as the sidecar's did on the same machine;
  `files` reads, only for a manifest that grants `files.read`; and
  `cancelled`, `progress`, `log`. A kernel refusal a plugin hands on unchanged
  keeps its error code.
- **Sandbox:** WASI with no preopened directories, no environment, no
  arguments and sockets refused; files only through `files`, read only, and
  only with the grant; a `StoreLimits` memory cap of 1 GiB;
  epoch interruption on a 20 ms tick with the same budgets the sidecar gave a
  job, 60 s per feature and per mesh pass, 180 s for `generateShape`;
  cancellation polled in the same callback, so a cancel stops a plugin mid
  loop. A trap poisons nothing: every call gets a fresh instance, so no state
  survives a call and a crashed plugin costs one feature.
- **Discovery** reads the manifests under `FUNDACAD_PLUGIN_DIR` (a checkout's
  own `plugins/` in a debug build), explicitly, from the engine's startup path
  only: a bare `builder::rebuild` has no plugins and an unknown type reads
  "unknown feature type", exactly as a document with no plugins installed
  always has. A component is compiled the first time one of its declared
  names is used, and the three sentences of `unregistered()` (absent,
  installed but broken, unknown) are kept.
- **Proof:** every in-repo plugin's geometry ships a component, each crate in
  its plugin's `geometry-rs`, and each checked against its own frozen corpus
  (section 5.1):
  - PrintToolbox, eight feature types: `tests/golden/corpus/corpus_plugins.json`,
    40 documents, volumes and refusals alike.
  - Screws, the `fastener` generator with its modelled threads on the kernel's
    helical sweep: `corpus_screws_ops.json`, 127 `generateShape` cases (every
    catalogue family at both ends of its table, the threads, drives and
    refusals): solids, validity and face counts exact, volumes to 1e-6, the
    preview mesh vertex for vertex, and a stored blob rebuilt as an import.
  - Printing, the slicer project exporter, with the person's slicer presets
    read through `files`: `corpus_printing_ops.json`, 14 `exportWith` cases
    compared entry by entry inside the zip.
  - Texture, the feature and its mesh pass: `corpus_texture.json`, 84
    documents (every kind, every control, planes, cylinders, cones, spheres,
    fillet corners, images, grime, several bodies, refusals), holding the
    meshes to the same triangles per face, every vertex and triangle to
    1e-5 of the frozen answer, the normals to 1e-4, the export, and the
    etags (stable on an identical rebuild, changed with the texture). They
    agree triangle for triangle. What makes that possible is recorded in the
    crate: matched pairwise sums and row by row axis-0 reductions, float `%`,
    `round`, `arange` and `unique` semantics, PCG64 and SeedSequence for the
    noise table, Qhull for every Delaunay, and the platform libm for every
    transcendental. The last two cannot be anything else: Qhull breaks a
    co-circular tie by its own insertion order, and one ulp of a cosine moves
    such a tie. What stays apart: LAPACK's `lstsq` and the port's QR agree to
    rounding, which only shows in the normal of a triangle with no area; and a
    JPEG heightmap's decoder (libjpeg-turbo there, zune-jpeg here) may round a
    pixel one level differently.
  - MultiColor, ExtraParameters and SpaceMouse have no engine geometry.
- **Shared algorithms:** the TypeScript copies stay (the frontend needs them
  synchronously for previews); the Rust twin is ported from the TypeScript,
  and both run the same JSON test vectors under `tests/vectors/`. Compiling
  `fundacad-core` to wasm for the frontend is an option if the vectors ever
  fail to keep them in step, not a plan.
- **Sketch solver:** unchanged, the frontend keeps the PlaneGCS wasm. The
  engine never solves sketches; it builds what the document stores.
- **Text:** glyph outlines from `ttf-parser` plus system font discovery with
  `fontdb`, not `Font_FontMgr`; the outline is converted to OCCT edges by us.
  Landed in `fundacad-geom::text`, measured against the sidecar's frozen
  answers by `tests/text_oracle.rs`. Single stroke fonts (the sidecar's
  bundled "Relief SingleLine CAD" font and its ribbon offset) are the one
  piece left out: the font is not ours to ship, so `singleline` resolves like
  any unknown family.

## 5. Test strategy

- **Nothing red, ever.** The sidecar was the reference until it was deleted
  from `main`, and it was deleted in one commit, not eroded.
- **Differential oracle, frozen.** While both engines existed, differential
  tools drove both over the same corpora and compared body count, per-body
  volume (rel 0.005), bbox (abs 1e-4) and the error list. Their answers are
  the golden files of section 5.1, and the corpora are in
  `tests/golden/corpus/`.
- **Protocol conformance.** The protocol suites that once ran against the
  sidecar's `fundacad-engine --ws` are now `crates/fundacad-engine`'s own
  tests. The engine answers a `testSleep` job under
  `FUNDACAD_ENGINE_TEST_OPS=1` and takes its clocks from
  `FUNDACAD_STALL_TIMEOUT` and `FUNDACAD_JOB_TIMEOUT`, so a cancel test has
  something long to cancel and a reap can be watched without waiting a minute.
- **Kernel tests in Rust.** `cargo test -p fundacad-geom` runs real
  OpenCASCADE tests.
- **Shared vectors.** A TypeScript mirror and its Rust twin both read one file
  under `tests/vectors/` (body ids, face colours, hole standards, parameters),
  recorded from the sidecar before it was deleted.
- **CI.** The `rust-geom` job caches `target/OCCT`, runs
  `cargo test --workspace --features fundacad-engine/ws`, every golden check,
  and the app shell's tests (`src-tauri`, including the container seam); it
  gates the alpha build.
- **Hygiene.** `scripts/check-repo-hygiene.sh` applies to Rust too.

### 5.1 Golden files

`tests/golden/*.golden.json` are the sidecar's frozen answers, one file per
corpus, holding exactly what each differential tool compared and the
tolerances it used. The corpora they answer are in `tests/golden/corpus/`.
Each header records the commit they came from. They live at the repository
root rather than in a crate because they span the CLI, the geometry crate and
the MCP server, and outlive the engine that wrote them.

`fundacad-engine golden-check tests/golden/<name>.golden.json` rebuilds the
corpus on the Funda Engine, in process, and compares with the same rules,
printing the diff tool's table and exiting 1 on any mismatch;
`crates/fundacad-mcp/tests/parity_golden.rs` replays `parity.jsonl` against the
MCP server and wants the recorded transcript word for word. CI runs both
in the `rust-geom` job.

- **A deliberate behaviour change** in the Funda Engine that moves a golden
  answer updates that golden in the same commit, with the reason in the commit
  message. There is no sidecar left to ask: re-record the named case
  with `golden-check <golden> --record <case>` (or edit the value by hand),
  and review the diff, which touches only that case.
- **A new corpus document** has no frozen answer. Add it to the corpus, look
  at what the engine does with it (in the app, or measured by hand), and only
  then run `golden-check <golden> --record <name>`, which writes this engine's
  answer in the same shape, updates `corpusSha256` and lists the case under
  `rustRecorded` in the header. That case is a regression check against a
  human judgement, not parity with the old engine, and the commit says so. The
  coverage golden's constants are the tool's own arithmetic, not answers, and
  are edited by hand.
- **Another platform's C math library.** The answers were frozen on Windows.
  glibc and the Windows CRT round some `sin`, `cos` and `pow` results one ulp
  apart (the plugin `numeric` import and OpenCASCADE both call the platform
  libm), and where that ulp decides a tie, a Delaunay diagonal between
  cocircular points, a mesh node on one of two symmetric sides or a coordinate
  on a rounding boundary, Linux answers differently from Windows and neither is
  wrong. Such a case keeps the sidecar's answer and gains the platform's own
  beside it: `golden-check <golden> --record-platform <names>`, run on that
  platform after checking the difference is only such a tie, writes it under
  `platformVariants.<os>`, and only that OS is held to it. Text cases need the
  font they were frozen with; `golden-check` skips one whose font is not
  installed rather than compare a stand in (CI installs Arial and Times New
  Roman; Consolas has no Linux package).

## 6. The `alpha` rolling release

The sidecar lives on the `legacy` branch, which keeps publishing the rolling
`beta` release and `beta/latest.json` from its own copy of `build.yml`, and
the Funda Engine is `main`, which publishes this rolling `alpha`. Alpha
rather than beta because the Funda Engine is the less tested of the two. The
workflow on `main` has no beta jobs at all.

A second rolling release beside `beta`, on the tag `alpha`. Two jobs in
`.github/workflows/build.yml`, `build-alpha` and `release-alpha`, with
their own `concurrency.group` (`release-alpha`), their own rolling tag
moved in place rather than deleted, their own `latest.json` and the same
old-asset sweep. What makes the bundle:

- The engine is a worker process of the same executable, reached over Tauri
  IPC (`src/geometry/transport.ts`).
- `src-tauri/tauri.alpha.conf.json` on top of `tauri.conf.json` for the
  release bundle settings and the MCP server beside the app. Neither declares
  a resource, so no sidecar runtime can be bundled, and the job checks the
  finished binary for the `engine_attach` command and the bundles for any
  sidecar runtime, so what shipped is a fact about the bytes rather than
  about the arguments.
- Title: `FundaCAD 1.0 alpha, Funda Engine (rolling)`.
- Release notes open with the warning, which is not optional: this is the
  Funda Engine and less tested than the beta, anything that builds differently
  from the beta is worth a report, plugin geometry runs only for plugins that
  ship a WebAssembly component (PrintToolbox so far), the beta continues on
  the sidecar from `legacy`, and files open in both.

### 6.1 The updater endpoint

**Decided: its own feed, at its own endpoint, baked into its own build.** A
rolling build that cannot update itself is one people install once and never
update again, so there is no world where the alpha ships with no manifest at
all.

The endpoint is compiled into the binary (`tauri.conf.json` on `main`), so
which feed a copy reads is settled when it is built and can never change
afterwards:

- a beta build reads `releases/download/beta/latest.json`, which only the
  `release` job writes, and only on `legacy`;
- an alpha build reads `releases/download/alpha/latest.json`, which
  only `release-alpha` writes, and only on `main`.

Neither job touches the other's release, and the two builds download their
artifacts by pattern (`fundacad-beta-*`, `fundacad-alpha-*`) so one run's
installers cannot be published to the other's page. `tests/security/updater.
test.ts` holds the pair apart.

The separation has to be the endpoint and cannot be the version: the alpha
is `1.0.x` and the beta is `0.2.x`, so a beta install that ever read the
alpha manifest would happily take it.

### 6.2 The version

`1.0.<run number>`: the Funda Engine is the major upgrade, so it is 1.0 (the
base version in `package.json`, `src-tauri/Cargo.toml` and
`src-tauri/tauri.conf.json` is `1.0.0`), and the title says `FundaCAD 1.0
alpha`.

No `-alpha` or `-rust` suffix. Tauri's msi target refuses a version whose
pre-release identifier is not numeric ("optional pre-release identifier in app
version must be numeric-only and cannot be greater than 65535 for msi target"),
so a suffix fails the Windows leg outright, and the NSIS target silently
rewrites a non-numeric field to `0` in `VIProductVersion`. The tag, the title,
the notes and the feed say alpha instead.

`tauri.alpha.conf.json` must not declare a `version`: CI stamps the one in
`tauri.conf.json`, and a version in the merged config would override the stamp.

### 6.3 The CSP

`connect-src` keeps `ipc:` and `http://ipc.localhost` and nothing else. The
beta grants `ws://127.0.0.1:8765 http://127.0.0.1:8765` because its frontend
talks to the sidecar over a loopback WebSocket; this engine is a stdio
worker reached over Tauri IPC, so the webview never opens a socket.
`tests/security/csp.test.ts` pins the tightened policy.

### 6.4 Before the first alpha release is cut

- The `build-alpha` job compiles OpenCASCADE from source on all three
  runners, about twenty minutes cold, cached at `src-tauri/target/OCCT`; the
  Linux leg installs `cmake`, which `.github/actions/linux-deps` deliberately
  leaves out.
- The updater is still off everywhere. `tauri.conf.json` carries upstream's
  minisign pubkey, so both release jobs withhold `latest.json` and say so in
  the notes. Generating a keypair turns both feeds on at once.
- Plugin bundles ARE published to this release, packed by `build-alpha` with
  their geometry components and nothing else, and the app installs from it
  (`RELEASE_TAG` in `src/plugins/index.ts`). Every plugin in the repository
  ships a component. The beta and the alpha share one plugin directory on a
  machine that has both, and a bundle the alpha installed has no sidecar
  half, so the beta cannot build that plugin's features until the beta's own
  bundle is installed again.
- `fundacad-mcp` is linked into the app and runs through `fundacad --mcp`, its
  private engine is the app started with `--engine --ws`, and the app's worker
  serves a loopback WebSocket beside its stdio pipe for live sessions
  (docs/MCP.md).

## 8. Performance

The sidecar ran one job per process with OCCT's own thread pool inside
BRepMesh and BOPAlgo, and helper processes for the payload loop of a large
import. The Funda Engine keeps the kernel where it is and fans the passes
above it across cores instead.

**The rule is identical replies.** A reply's bytes depend on body order, face
order, ids, etags, the error list and the diagnostics, so every parallel pass
here collects its results by index and is assembled in the serial order. No
pass sums, hashes or inserts in completion order. Where that could not be
arranged, the pass stayed serial.

That is checked, not asserted: `bench_suite digest` encodes each document's
whole binary reply frame and prints a digest of it, and the differential corpus
plus a 144 body imported assembly give the same digests at
`FUNDACAD_THREADS=1` as on 32 threads.

### 8.1 The benchmark set

`crates/fundacad-geom/examples/bench_suite.rs`, one stage per run, one JSON
line out (`cargo run --release -p fundacad-geom --example bench_suite -- ...`):

| Stage | What it measures |
|---|---|
| `corpus <corpus_engines.json>` | rebuild and mesh every differential document |
| `doc <file.funda>` | one document cold, its mesh, and an unchanged warm rebuild |
| `import <file.step>` | import, rebuild, the payload loop, the binary frame and an STL and 3MF export |
| `export <file.funda> [formats]` | the writers on their own |
| `faces <document>` | face bands and the body payload per shape |
| `smooth <document\|file.step>` | the batched smooth edge test against the per sample walk it replaced, edge by edge |
| `digest <document\|corpus.json\|file.step>` | the whole reply frame as a digest, to compare a serial run with a parallel one |

`FUNDACAD_BENCH_PHASES=1` adds a phase table (`crate::bench`).
`FUNDACAD_THREADS` caps both the engine's rayon pool and OCCT's.

The gates double as benchmarks: `fundacad-engine fillet-eval` over the 500 case
corpus and `select-eval` over the 220 case one.

### 8.2 What runs in parallel

- **The payload loop, per body** (`mesh::built_payloads`). Cache hits are read
  on the calling thread in body order, the misses are meshed elsewhere, the
  cache is written back in body order. Every body still ticks progress once,
  whichever tier answered it, which is what the stall watchdog is promised.
- **Edge polylines, per edge** and **face bands** (adjacency, the surface read
  and the near pair search) within one body.
- **Export tessellation, per body**, a batch at a time so the triangle budget
  still refuses at the body that passes it, with the same count in the message.

An assembly places one product many times and a placed copy keeps the product's
`TShape`, so two threads meshing two placements would write one triangulation.
`par::share_groups` unions the bodies that share a face and runs each group on
one thread, in body order; the groups run beside each other.

### 8.3 What stayed serial, and why

- **The timeline.** A feature reads the bodies the one before it left.
- **`fuse_cells` in a pattern.** The cells are fused one at a time onto the
  growing body; a balanced tree would give a different face order, so
  different etags and selectors.
- **The section blend** (`blend_section.hxx`), the corpus's hot spot at about
  14 s of a 25 s corpus rebuild. It is a chain of dependent kernel steps
  (sections, sweep, boolean, then solid classification to verify), and its cost
  is OCCT's.
- **The STEP reader.** `STEPCAFControl_Reader` is one parse of one file and is
  not thread safe. It is the largest single number left in an import.

One copy is still left on the reply path, and is left on purpose. The
supervisor reads a frame into a `Vec` (`stdio::read_message_limited`) and
`engine.rs`'s `deliver` then copies the whole frame again into a second `Vec`
only to put the one byte of message kind in front of it. On the 38 MiB frame a
144 body assembly produces that is a few milliseconds, the same order as
encoding the frame at all. Removing it means the reader allocating the kind
byte's slot up front and `Message` carrying that layout, which changes the
type the protocol suites drive; not worth it for the size of the win.

### 8.4 GPU offload: evaluated, not taken

Stage by stage:

- **Tessellation.** BRepMesh walks B-rep topology and refines a 2D Delaunay per
  face against a tolerance. Irregular control flow over a C++ object graph, and
  the only way to move it is to write a new mesher, whose triangles would not be
  OCCT's. Parity ends there.
- **Mesh post processing** (true normals, the seam weld, `display_face`).
  Measured at 0.15 s of a 39 s import. The upload and readback would cost more
  than the work.
- **Face bands.** The O(n squared) screen is a bounding box broad phase a GPU
  would like, but the exact test is `BRepExtrema_DistShapeShape` on the CPU, and
  after the fan out the whole pass is under two seconds.
- **Booleans and blends.** Exact B-rep intersection, sequential by nature.
- **Displacement mesh passes** (the Texture plugin) are the one genuinely GPU
  shaped stage: a procedural field evaluated over millions of vertices with no
  topology. But a displaced mesh feeds the export and the etag, and GPU float
  results are not reproducible across vendors, drivers or shader compilers
  (contraction, fast math, different transcendental rounding). A model would
  export differently on two machines.

Cost: wgpu and naga are around sixty crates, and a GPU path needs a CPU
fallback anyway for headless CI, virtual machines and driver loss. Two paths
that must agree bit for bit is the opposite of the rule this section opens
with.

**Recommendation: no GPU in the engine.** The time that is left is OCCT's (the
STEP read, BRepMesh, the section blend), none of it GPU shaped, and everything
above OCCT is now either parallel or under a second. The GPU the product
already uses is three.js in the viewport, which is where anything purely visual
belongs.
