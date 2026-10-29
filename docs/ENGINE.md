# The Funda Engine

The Funda Engine is FundaCAD's geometry engine: Rust, OpenCASCADE 7.8.1
statically linked, built into the same executable as the app. It ships as
`main`'s rolling 1.0 beta, and as `dev`'s development build ahead of it
(section 7). The sidecar, the previous engine, is retired and frozen on the
`legacy` branch, which publishes nothing.

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
  sidecar's own manifest key runs on the retired sidecar alone until it ships
  a component.

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
  only: a bare `builder::rebuild` has no plugins and an unknown type is
  skipped as "unknown feature type", exactly as in a document with no plugins
  installed. A skip is not an error: the rebuild lists it in `skippedFeatures`
  (docs/PROTOCOL.md) and builds the rest. A type a plugin declares but cannot
  run is still an error. A component is compiled the first time one of its declared
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
  Under the same switch `FUNDACAD_TEST_HOLD="import=20000,rebuild=6000"` holds
  every job of the named ops that long before it runs (a cancel ends the hold),
  so an end to end check can switch documents while a long import runs.
- **Kernel tests in Rust.** `cargo test -p fundacad-geom` runs real
  OpenCASCADE tests.
- **Shared vectors.** A TypeScript mirror and its Rust twin both read one file
  under `tests/vectors/` (body ids, face colours, hole standards, parameters),
  recorded from the sidecar before it was deleted.
- **CI.** The `rust-geom` job caches `target/OCCT`, runs
  `cargo test --workspace --features fundacad-engine/ws`, every golden check,
  and the app shell's tests (`src-tauri`, including the container seam); it
  gates the beta build.
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
- **The disk cache follows the shapes, not the binary.** Checkpoints are keyed
  on `GEOMETRY_VERSION`, `CACHE_FORMAT` and the OCCT version in
  `crates/fundacad-geom/src/cache/keys.rs`, so an app update reopens a long
  document from disk. A change that can move the shape a document builds to,
  an OCCT patch at the same version included, bumps `GEOMETRY_VERSION` in the
  same commit; a change to what a checkpoint holds bumps `CACHE_FORMAT`.
  Re-recording an engine golden fails `geometry_version_tracks_the_golden_answers`
  until the new digest is added to `GOLDEN_DIGESTS`, and
  `each_golden_digest_came_with_a_version_bump` fails until `GEOMETRY_VERSION`
  is the last pair's version and higher than the one before, as the reminder.
  Neither sees a pair whose digest was replaced in place, which only a version
  that has not shipped may take, so review checks that. Plugins are keyed on
  their manifest and component bytes, and a build with uncommitted engine
  edits on those edits.
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

## 6. The `beta` rolling release

A push to `main` publishes the rolling `beta` release and `beta/latest.json`.
It was published as `alpha` while the sidecar still published the beta from
the `legacy` branch. The sidecar is retired now and `legacy` publishes
nothing. Daily work lands on `dev`, which publishes the `development` build
ahead of the beta, see section 7.

Two jobs in `.github/workflows/build.yml`, `bundle` and `release`, with the
beta in its own `concurrency.group` (`release-beta`), a rolling tag moved in
place rather than deleted, a `latest.json` and an old-asset sweep. What makes
the bundle:

- The engine is a worker process of the same executable, reached over Tauri
  IPC (`src/geometry/transport.ts`).
- `src-tauri/tauri.beta.conf.json` (or `tauri.dev.conf.json` and
  `tauri.stable.conf.json`, the same file with their own feed) on top of
  `tauri.conf.json` for the release bundle settings and the MCP server beside the app. Neither declares
  a resource, so no sidecar runtime can be bundled, and the job checks the
  finished binary for the `engine_attach` command and the bundles for any
  sidecar runtime, so what shipped is a fact about the bytes rather than
  about the arguments.
- Title: `FundaCAD 1.0 beta, Rust engine (rolling)`.
- Release notes open with `docs/release-notes/beta.md` when it exists (7.1),
  then the warning, which is not optional: this is the Funda Engine and the sidecar is retired, anything that builds differently from the sidecar is worth a report, plugin
  geometry runs as WebAssembly components, and the sidecar's documents open
  here.
- Every beta also stays on as a normal release of its own, `v1.0.<run
  number>`, titled `FundaCAD 1.0.<run number> beta`, with the same installers
  and plugin bundles plus a `SHA256SUMS.txt`, but no `latest.json`, so a version can be linked and
  packaged after the rolling beta moves on while installed betas keep their
  feed. It starts as a draft until its files are up, and is the repository's
  latest release only while no stable release is published (stable installs
  find their feed through `releases/latest`). Its tag is made on the build's
  commit when the draft is published, by the job's token, which GitHub refuses
  on a commit that changes a workflow file, so such a build deletes the draft,
  warns and has only the rolling beta.
  `tests/build/test_version_release.py` runs the step against a stub `gh`.

### 6.1 The updater endpoint

**Decided: a feed at a fixed endpoint, baked into the build.** A rolling
build that cannot update itself is one people install once and never update
again, so there is no world where the beta ships with no manifest at all.

The endpoint is compiled into the binary (`tauri.conf.json`, or
`tauri.dev.conf.json` and `tauri.stable.conf.json` for the other channels),
so which feed a copy reads is settled when it is built and can never change
afterwards:

- a beta build from `main` reads `releases/download/beta/latest.json`, which
  only the beta `release` run writes;
- a development build from `dev` reads
  `releases/download/development/latest.json`, which only the development
  `release` run writes;
- a stable build reads `releases/latest/download/latest.json`, see section 7;
- a sidecar build from `legacy` reads the same `beta/latest.json`. It is
  `0.2.x` and the Funda Engine is `1.0.x`, so those installs move to the
  Funda Engine, which is intended;
- a build from the `alpha` days reads `releases/download/alpha/latest.json`.
  The `alpha` release is gone, so those installs no longer update and take a
  new installer from the beta release.

`tests/security/updater.test.ts` pins every endpoint and keeps the alpha one
out of every config.

### 6.2 The version

`1.0.<run number>`: the Funda Engine is the major upgrade, so it is 1.0 (the
base version in `package.json`, `src-tauri/Cargo.toml` and
`src-tauri/tauri.conf.json` is `1.0.0`), and the title says `FundaCAD 1.0
beta`.

No `-beta` or `-rust` suffix. Tauri's msi target refuses a version whose
pre-release identifier is not numeric ("optional pre-release identifier in app
version must be numeric-only and cannot be greater than 65535 for msi target"),
so a suffix fails the Windows leg outright, and the NSIS target silently
rewrites a non-numeric field to `0` in `VIProductVersion`. The tag, the title,
the notes and the feed say beta instead.

`tauri.beta.conf.json` must not declare a `version`: CI stamps the one in
`tauri.conf.json`, and a version in the merged config would override the stamp.
A stable build is stamped with its tag's version instead.

### 6.3 The CSP

`connect-src` keeps `ipc:` and `http://ipc.localhost` and nothing else. The
sidecar build granted `ws://127.0.0.1:8765 http://127.0.0.1:8765` because its frontend
talks to the sidecar over a loopback WebSocket; this engine is a stdio
worker reached over Tauri IPC, so the webview never opens a socket.
`tests/security/csp.test.ts` pins the tightened policy.

### 6.4 Notes on the release

- The `bundle` job compiles OpenCASCADE from source on all three
  runners, about twenty minutes cold, cached at `target/OCCT` (the install
  only, not the build tree beside it) under the same key as `rust-geom`'s; the
  Linux leg installs `cmake`, which `.github/actions/linux-deps` deliberately
  leaves out.
- The updater is still off everywhere. `tauri.conf.json` carries upstream's
  minisign pubkey, so `release` withholds `latest.json` and says so in
  the notes, on every channel. Generating a keypair turns the feed
  on.
- Plugin bundles ARE published to this release, packed by `bundle` with
  their geometry components and nothing else, and the app installs from it
  (`RELEASE_TAG` in `src/plugins/index.ts`). A development or stable build
  installs from its own release, which carries bundles from the same commit
  (`VITE_FUNDACAD_RELEASE`). Every plugin in the repository
  ships a component. A sidecar build shares one plugin directory with this
  one on a machine that has both, and a bundle the Funda Engine installed has
  no sidecar half, so the sidecar build cannot build that plugin's features.
- `fundacad-mcp` is linked into the app and runs through `fundacad --mcp`, its
  private engine is the app started with `--engine --ws`, and the app's worker
  serves a loopback WebSocket beside its stdio pipe for live sessions
  (docs/MCP.md).

## 7. Release channels

| Branch or tag | Tests | Installers | Publishes | Version | Update feed |
| --- | --- | --- | --- | --- | --- |
| `dev` | yes, may be red | built even when the tests are red | the rolling `development` pre-release, bleeding edge | `1.0.<run number>` | `releases/download/development/latest.json` |
| `main` | yes | only once the tests are green | the rolling `beta` pre-release, somewhat stable | `1.0.<run number>` | `releases/download/beta/latest.json` |
| tag `v1.<minor>.<patch>` on `main`, optional | yes | only once the tests are green | a release named after the tag | `1.<minor>.<patch>` | `releases/latest/download/latest.json` |
| pull request | yes | none | nothing | | |

The `channel` job in `build.yml` decides which row a run is.

**`dev` is the bleeding edge.** Daily work lands there, and every push
publishes the `development` build, so testers get a change with the next
build. A red `test` or `rust-geom` does not hold the build back, though the
build still starts only once both have finished. The run still shows red, so
the breakage is visible. A bundle leg that fails to build only
leaves its own files out: the release keeps the earlier build's copies, the
notes name what was not rebuilt, and `latest.json` leaves that platform out
until the next build.

**`main` is the beta, somewhat stable.** A push to `main` publishes the beta
exactly as it did before `dev` existed, and only when `test`, `rust-geom`
and every bundle leg are green. Changes reach `main` by promotion (7.1) or as
a hotfix (7.2).

**Each installer is started before it ships.** After a bundle leg has
packaged, `scripts/bundle-smoke.py` starts the AppImage, the binary of the
`.deb`, the Windows portable exe and the macOS app's binary with `--mcp`,
and `build-flatpak` starts the installed Flatpak the same way. Over stdio
each one opens a document, adds a 30 x 20 x 10 mm box, builds it through the
engine inside the package and checks the volume is 6000 mm3. On `dev` a red
smoke is an annotation and the build still ships. On `main` it fails the leg,
which holds the beta, or for the Flatpak leaves the Flatpak out of it. The
bundle runner has every library `linux-deps` installs, so a `.deb` or
AppImage with a wrong dependency still starts there, so the `deb-install` job
installs the `.deb` in clean Ubuntu 22.04, Ubuntu 24.04 and Debian 12
containers and runs the AppImage on a Fedora 40 that has only python3 (it must
name the missing WebKitGTK, then start once that is installed), each ending
in the same smoke. It is not in the release job's `needs`, so for now a
broken `Depends` shows red without holding the beta. A second Linux step opens the AppImage window
under Xvfb and builds the box through a server attached to it, which proves
the page loaded; it does not gate anything yet.

The two never touch each other's release. Each has its own tag, its own
concurrency group (`release-development`, `release-beta`) and its own feed,
baked into the binary. A development install only updates to the next
development build and a beta install to the next beta.

**On Windows and macOS the development build is FundaCAD Dev**, its own
product (`src-tauri/tauri.dev-product.conf.json`, added to the build by
`build.yml` for `dev` only): identifier `dev.fundacad.app.dev`, binary
`fundacad-dev`, its own Start menu entry, install folder and `.app`, so it
installs beside the beta. A separate identifier is a separate data folder, so
its preferences, recovery files, document cache, plugins and MCP session are
its own and a broken development build cannot touch the beta's. It registers
no file types, `.funda` and `.fundab` stay with the beta. The binary is
renamed because the NSIS installer closes running copies of its binary by
name, and an update of one channel must not close the other. On Linux it
keeps the beta's names, since the `.deb`, Flatpak and container checks are
keyed on them, so there switching channel is installing the other channel's
package, and as both count up the same run number, moving to a lower version
can need an uninstall first. On every platform the window title says FundaCAD Dev, and
About, the update prompts and a problem report show the version as
`dev-<run number>`; the real version stays `1.0.<run number>`, which the
updater compares. An install of a development build from before the rename
is a separate "FundaCAD" install: its next update installs FundaCAD Dev
beside it, and the old one can be uninstalled.

An update started from the portable exe is the first install of that
channel. The updater always runs the setup as `/P /R /UPDATE`, and the Tauri
NSIS template skips the shortcuts in update mode, so
`src-tauri/windows/installer-hooks.nsh` drops update mode when the binary is
not installed yet; that install then makes the Start menu and desktop
shortcuts a passive install makes. The Windows bundle leg checks both cases
on the built setup.

The tag is `development` rather than `dev`: a tag and a branch with the same
name make `git push origin dev` fail as ambiguous for anyone who fetched
tags.

**Stable tags are optional.** A `v1.<minor>.<patch>` tag on a commit of
`main` still publishes a stable release with its own feed, but nothing sends
people there. A tag that is not `v1.<minor>.<patch>` with a minor of 1 or
more, or whose commit is not on `main`, fails `channel` before anything is
built. The betas are `1.0.<run number>`, and a stable `1.0.x` would be older
than the beta it replaces. A new stable release is a draft until its
installers and `latest.json` are up, and is then marked latest only while no
higher stable release is published. GitHub's latest release is never a
pre-release, so neither rolling build can become what a stable install finds
there.

### 7.1 Promoting dev to main

```sh
scripts/promote.sh                   # the dev head, or --sha <commit on dev>
scripts/promote.sh --push            # the same, and push main
scripts/promote.sh --stable 1.2.0    # also tag the merge, optional
```

It checks that a `build` run from a push of that commit to `dev` has `test`,
`rust-geom` and every `bundle` leg green. `dev` may be red, a promotion may
not. It then merges the commit into `main` with `--no-ff` in a throwaway
worktree and prints the push. `--push` pushes `main`, with the tag in the
same atomic push when there is one. The `main` run tests again and publishes
the beta.

The beta page opens with `docs/release-notes/beta.md`, which the release job
puts above its generated part and which replaces the generated commit list.
It is written by hand, so edit it on `dev` before a promotion: what is new
since the last beta, what to know before installing, the known limits. The
job does not overwrite it, and without the file it publishes the generated
notes alone. `promote.sh` says when the file is the same on the commit it
promotes as on `main`. A beta installed before the signing key changed cannot
update itself, so the notes say to install by hand once, until none are left.

`e2e` is not gating, so a flake there does not block a promotion. A dev
commit that only touches `manual/` starts no build at all, so promote an older
one with `--sha`. Your local `main` is not touched, fast forward it
afterwards.

### 7.2 Hotfixes

A fix that cannot wait for the next promotion branches from `main`, merges
into `main`, and `main` is merged back into `dev` straight away:

```sh
git fetch origin
git switch -c fix/thing origin/main      # branch from main
# commit the fix
git switch main && git merge --ff-only origin/main && git merge --no-ff fix/thing
git push origin main                     # the beta, once the run is green
git switch dev && git merge --ff-only origin/dev && git merge main && git push origin dev
```

`promote.sh` leaves local `main` behind `origin/main`, which is why both
branches are fast forwarded first: a stale `main` gets the push refused, and
a stale `dev` merges an old `main`. Until `main` is merged back, the next
promotion can conflict, and `promote.sh` stops and says so. For a stable
release of the fix too, tag the merge and push it with `main`:
`git tag -a v1.2.1 -m "FundaCAD v1.2.1"` and
`git push --atomic origin main refs/tags/v1.2.1`.

### 7.3 Rolling the channels out

The first time, in this order. Until now `main` published the beta with the
old workflow and the `development` release does not exist yet.

1. Create the `development` tag by hand on the current `dev`, with your own
   credentials: `git push origin refs/remotes/origin/dev:refs/tags/development`.
   `GITHUB_TOKEN` may not create or move a tag onto a commit that changes a
   workflow file, so without this the first run cannot create it and its
   release job fails, saying so.
2. Merge the channels change into `dev` and push `dev`. That run publishes
   the `development` release. The tag move is refused for the same reason,
   so the run warns and the release's source archives and the notes' range
   stay on the old commit until the tag is moved by hand.
3. Once that run's gating jobs are green, `scripts/promote.sh --push`. The
   `main` run publishes the beta as before, from the same feed, so existing
   beta installs keep updating. If it warns that the `beta` tag could not
   move, move it by hand the same way. The README and the manual go live
   from `main` with links to the beta and the development build, and both
   exist by then.

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
Always on, a cached rebuild's reply carries `timing` (copy, replay with its slowest feature, post, mesh in ms), and the
app writes one `edit` line per committed rebuild to its log: `edit 3.8 s: copy 2.8, replay 0.01 (fillet), post 0.3,
mesh 0.008 (1 part), reply 600 KB, apply 0.4`. Mesh is the wall time of the meshing step (bodies mesh in parallel, and stored mesh reads count in it), post is what the
engine did beyond the other three (document parse, the reply fields), apply the app's commit.

`crates/fundacad-cli/examples/bench_open.rs` times the document file itself, for
documents with big imports (`cargo run --release -p fundacad-cli --example bench_open -- ...`):

| Stage | What it measures |
|---|---|
| `scan <out.stl> [--triangles N]` | writes a deterministic binary STL shaped like a reference scan, 2,000,000 triangles by default |
| `pack <file> <out_stem>` | imports a file, saves it as `.fundab` and `.funda`, and times deflate level 1 and 6 and BLAKE2b on its biggest blob |
| `open <file>` | reads the document into an empty blob store, stage by stage, then the engine side: blob read, `blob_to_shape`, a cold rebuild and the mesh |
| `reopen <file>` | the same with the blob store already filled, the common case |

`--repeat N` reports the median, `--threads N` sets `FUNDACAD_THREADS` for the file layer.

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
