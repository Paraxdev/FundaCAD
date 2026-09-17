# The Rust pivot ("rustirisation")

Status: pre-alpha, work in progress. This document is the plan, the decision
record and the conversion target list for moving FundaCAD's backend from Python
to Rust. It is written to be executed one brick at a time by whoever picks up
the `rustirisation` branch, human or agent, and every brick must leave every
existing test suite green.

Related: [ARCHITECTURE.md](ARCHITECTURE.md) (what exists today),
[PROTOCOL.md](PROTOCOL.md) (the wire contract the new engine must honour),
[FUNDA-FORMAT.md](FUNDA-FORMAT.md) (already Rust), [PLUGINS.md](PLUGINS.md).

## 1. The decision

FundaCAD stays a Tauri 2 application with a Vue 3 + three.js frontend, for
good. Everything behind the frontend becomes Rust: geometry, tessellation,
document rebuild, file formats, import and export, the MCP server. The Python
sidecar, its bundled interpreter and the `uv` toolchain are deleted at the end.

An earlier draft of this plan kept a second end state open, a native egui +
wgpu shell replacing the webview. That is dropped. The UI is the largest and
most polished part of the product (75k lines of TypeScript and Vue, 60 browser
end-to-end scripts, 225 vitest files, a 12.5k line renderer with custom fat
lines, procedural surfaces, section caps and post effects), a native rewrite
would be months of work that produces nothing a user cannot already do, and
plugin panels are written in Vue. The frontend is not a stepping stone.

What the backend pivot buys:

- The Python runtime is most of the installer and the reason the app is a
  fixed port, a shared token, a stall supervisor and a crash classifier. A Rust
  engine is one more mode of the same executable.
- The seam is already drawn. `GeometryBackend` in `src/geometry/client.ts` is
  the only thing the frontend depends on, and fourteen test files stub it.
- The file formats are already Rust (`fnda.rs`, `container.rs`, `json_doc.rs`).
- About 1,700 lines of algorithms are duplicated between TS and Python
  (pattern expansion, region detection, face footprints, hole standards, face
  colour encoding) to keep preview and build in agreement. They get one Rust
  twin with shared test vectors instead of a Python one.

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
  it. A worker keeps today's behaviour: a crash restarts the engine and the
  app reports it, a cancel that the kernel does not honour within a grace
  period kills and respawns the worker. No Python, no port, no token for the
  app's own traffic, one binary to sign and ship.
- **Frames are unchanged.** A request is the JSON envelope of PROTOCOL.md, a
  reply is the existing binary frame (`[u32 header_len][JSON header][pad][f32
  and u32 buffers]`, chunked per body), and progress and chunk frames keep
  their shapes. Over stdio each frame gets a `u32` length and a one-byte kind.
  The frontend's frame decoder in `client.ts` is reused as is.
- **Webview transport is Tauri IPC.** One `engine_request` command takes the
  request and an `ipc::Channel`; the supervisor relays every frame for that
  request id to the channel as raw bytes (`InvokeResponseBody::Raw`, no JSON
  or base64 on the way). `engine_cancel` takes a request id. `client.ts`
  gains a transport interface with two implementations, WebSocket and IPC; the
  `TauriGeometry` spike class is deleted.
- **A WebSocket transport stays, outside the shipped window's path.**
  `fundacad-engine --ws` serves the same frames on 127.0.0.1 with the existing
  token and Origin gate. It is what `npm run dev` in a plain browser, the
  Playwright e2e scripts, `test_ws.py` and the differential harness use. The
  MCP live session reaches a running app through a loopback endpoint the main
  process opens with the same gate and publishes in `session.json`, relaying to
  the worker; that is decided in detail in its brick.
- **Worker state.** The in-memory prefix and mesh caches live in the worker
  and are lost on a restart; the blob store is on disk and survives, as today.

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
                     import and export, caches, plugin host.  <- FIRST BRICK
  fundacad-engine    the worker: op dispatch, job lock, cancel, stall
                     watchdog, stdio and WebSocket transports, live session.
  fundacad-format    fnda.rs, container.rs, json_doc.rs moved out of src-tauri
                     so the engine, the CLI and the app share them.
  fundacad-mcp       the MCP server on rmcp, replacing plugins/FundaCAD.MCP.
  fundacad-cli       headless rebuild/export/inspect for CI and evals.
src-tauri/           the app. engine.rs (supervisor, IPC relay) replaces
                     sidecar.rs; `--engine` dispatches into fundacad-engine.
third_party/opencascade-rs   vendored bindings (own workspace), extended
                     bridge by bridge as the port needs classes.
```

Kernel: OpenCASCADE 7.8.1, compiled statically from the `occt-sys` crate the
vendored bindings pull in (no system OpenCASCADE on any platform, one C++
toolchain at build time). The Python engine runs OCCT 7.9.3 through OCP, so
results can differ in the last digits; the differential harness compares with
tolerances, not bytes. Upgrading to upstream opencascade-rs 0.3 and later to
OCCT 8.0 is tracked, not a prerequisite.

### 2.3 Decisions on the open questions

- **Crash isolation:** a supervised worker process for the whole engine
  (section 2.1), not a child per risky operation. It is what the Python app
  does today, it makes cancel-by-kill uniform, and a pipe copy of a mesh is
  cheap next to tessellating it. Offset Face and Press/Pull run BRepOffset in
  process too, where the Python engine uses offset_child.py: the freeform
  faces measured to crash are refused before any offset, as in Python, and on
  OCCT 7.8.1 the chamfered bodies offset_child.py documents refuse cleanly
  (128 offsets and pushes over every face of two chamfered spools, no crash,
  the same errors as Python). The in-memory BREP round trip the child did is
  kept.
- **Plugin geometry:** a plugin's geometry stays in the plugin (docs/PLUGINS.md,
  no domain logic in core). The Python half of a bundle becomes a WebAssembly
  component the engine runs with wasmtime, built from a Rust crate inside the
  plugin folder. The engine offers a generic host API (build a solid from
  primitives and sketches, boolean, fillet, displace a face triangulation,
  read and write blobs, write an export file) and knows nothing of fasteners,
  textures or printers. The `featureTypes`, `exporters` and `shapeGenerators`
  manifest keys stay, so documents do not change. Until the host exists,
  plugin geometry runs only on the Python engine and the pre-alpha notes say
  so.
- **Shared algorithms:** the TypeScript copies stay (the frontend needs them
  synchronously for previews); the Rust twin is ported from the TypeScript,
  not from Python, and both run the same JSON test vectors under
  `tests/vectors/`. Compiling `fundacad-core` to wasm for the frontend is an
  option if the vectors ever fail to keep them in step, not a plan.
- **Sketch solver:** unchanged, the frontend keeps the PlaneGCS wasm. The
  engine never solves sketches; it builds what the document stores.
- **Text:** glyph outlines from `ttf-parser` plus system font discovery with
  `fontdb`, not `Font_FontMgr`; the outline is converted to OCCT edges by us.

## 3. Phases

Each phase ends with every suite green: vitest, the sidecar and plugin Python
tests (until the sidecar is deleted), `cargo test` across the workspace, the
geometry evals and the CI e2e scripts. A phase that needs a suite red to make
progress is planned wrong.

### Phase 0, the first brick (done)

- Root Cargo workspace, `crates/fundacad-geom` on a static OpenCASCADE 7.8.1
  with real kernel tests (box volume and area, boolean cut, per-face
  tessellation in the protocol v2 body payload shape).
- The vendored bindings gain `Shape::volume()` and `Shape::surface_area()`.

### Phase 1, the pipe works end to end

1. `fundacad-protocol`: port `wire.py` (envelope, binary frames, chunking,
   progress frames, stdio framing) with tests from the
   `tests/geometry/{assemble,chunkStream,client}.test.ts` fixtures.
2. `fundacad-core` schema: `CadDocument`, the core feature types, sketch
   entities, constraints, patterns, selectors, plane specs, parameter
   definitions. Serde with the exact JSON names of `src/types.ts`; round-trip
   the fixture documents in the repo.
3. `fundacad-geom` builder skeleton: timeline replay with no-op on failure and
   per-feature errors carrying the feature id, body ids, primitives and
   move/scale/mirror, sketch profiles, extrude, boolean, tessellation into the
   body payload.
4. `fundacad-engine`: `rebuild`, `computeAll`, `ping`, `cancel`, progress; the
   stdio and WebSocket transports; `fundacad-cli rebuild <doc.json> --json`.
5. `sidecar/tools/diff_engines.py`: both engines on the same documents,
   comparing body count, per-body volume (rel 5e-3), bbox (abs 1e-4) and the
   error list.
6. `src-tauri/src/engine.rs` and the IPC transport in `client.ts`, selected by
   a developer setting (`engine: "python" | "rust"`), Python the default. The
   `VITE_GEOM=rust` spike and `src-tauri/src/geom.rs` are deleted; its tests
   move into `fundacad-geom`.
7. The `prealpha-rust-ver` rolling release (section 6).

### Phase 2, parity

1. Remaining feature handlers, each with a differential test: revolve, split,
   fillet and chamfer (plain circular, then conic and section-blend fallbacks),
   shell, thicken, offsetFace, draft, press-pull, hole, patterns, loft, sweep,
   imprint, deleteFace, cleanUp, simplifyMesh, joint, datums, text.
2. Selectors (`geom_select.py`, `topo_adj.py`, `selector_tuning.json`), gated
   by `eval_selector_survival` at the same 0.990 on the frozen 220-case corpus.
3. Tessellation details: faceOwners, faceBands, true normals and seam weld,
   etags, tolerance tiers, density cap, smooth edge tags.
4. Caches: content-addressed blob store (blake2b-128, `.bbrep`), prefix
   checkpoint cache, mesh artifact cache.
5. Import (BREP, STEP with XCAF colours and assemblies, STL, 3MF, OBJ, GLB) and
   export (STEP, STL, 3MF with colours, GLB), `inspect`, `interference`,
   `projectGeometry`, `tessellateText`, `listFonts`, `migrateGeometry`.
6. Plugin host (section 2.3) and the in-repo plugins' geometry ported to wasm
   components: Screws, PrintToolbox, Printing, Texture.
7. `fundacad-mcp` on rmcp, same tool vocabulary (docs/MCP.md).
8. Gates: `eval_fillet_corpus` 0/500, `e2e_coverage.py` 34/34, the golden
   corpus, and the Python protocol suites (`test_ws.py`, `test_cancel.py`,
   `test_conn_limit.py`, `test_fullstack.py`) run against
   `fundacad --engine --ws` through a `FUNDACAD_ENGINE_CMD` variable.

### Phase 3, cutover

1. Rust becomes the default engine in the beta.
2. After one beta with no engine regressions reported, delete `sidecar/`,
   `scripts/build-sidecar-runtime.*`, `sidecar.rs`, the WebSocket client's
   token fetch from Tauri, the `uv` steps in CI, the Python plugin geometry and
   the `sidecar-runtime` bundle resource, in one commit.
3. `fundacad-format` and `fundacad-cli` extracted; the three gated evals ported
   to the CLI.

## 4. Conversion targets

LOC are `wc -l` of the current tree. "Oracle" is what proves the port right.

### 4.1 Python sidecar

| Source (sidecar/) | LOC | Target | Risk | Oracle |
|---|---|---|---|---|
| live_session.py | 188 | fundacad-engine::live | low | tests/test_live_session.py, MCP test_live_session |
| face_colors.py | 117 | fundacad-core::face_colors | low | tests/document/faceColors.test.ts vectors |
| body_ids.py | 76 | fundacad-core::body_ids | low | tests/document/bodyIds.test.ts |
| pick_fuzz.py, plane_spec.py, errors.py, appenv.py, progress.py | 314 | fundacad-core / engine | low | unit |
| sysmem.py | 130 | fundacad-engine::sysmem (sysinfo crate) | low | unit |
| blobstore.py | 168 | fundacad-format::blobstore (already half in container.rs) | low | container_seam.rs |
| mesh_refine.py, mesh_writers.py | 426 | fundacad-geom::export::{stl,threemf,glb} | low | compare with Python output on fixtures |
| wire.py | 455 | fundacad-protocol | low | vitest chunkStream/assemble fixtures |
| font_guard.py | 167 | deleted (no fontTools) | none | |
| occt_smp.py | 59 | OSD_ThreadPool config in fundacad-geom::kernel | low | |
| topo_adj.py | 177 | fundacad-geom::topo | low | test_topo_adj |
| shape_util.py | 686 | fundacad-geom::shape (BREP io, debris, unify, ShapeFix) | medium, needs ShapeFix bridge | test_smoke |
| tessellate.py, viewport_mesh.py | 1,328 | fundacad-geom::mesh (started) | medium | mesh volume/bbox invariants, faceIds count |
| face_plane.py | 229 | fundacad-geom::planes | low | test_datum_face |
| geom_select.py, selector_tuning.json | 1,087 | fundacad-geom::select | high | eval_selector_survival >= 0.990 |
| face_bands.py, face_footprint.py | 668 | fundacad-geom::faces | medium | test_face_bands, faceFootprint.test.ts |
| sketch_build.py | 870 | fundacad-geom::features::sketch | medium | test_sketch_*, region tests |
| builder.py, handler_util.py | 1,809 | fundacad-geom::builder | medium | test_smoke, golden corpus |
| booleans.py | 906 | fundacad-geom::features::boolean | high | test_boolean*, test_sealed_void |
| blends.py, conic_blend.py, section_blend.py, blend_overlap.py | 3,277 | fundacad-geom::features::blend | highest | eval_fillet_corpus 0/500, test_conic_blend, test_section_blend |
| solid_ops.py, offset_child.py | 827 | fundacad-geom::features::{presspull,shell,offset,draft,pattern} | high | test_presspull, test_shell_wall |
| defeature.py, heal_snapped.py | 1,173 | fundacad-geom::features::defeature | high, needs BOPAlgo_RemoveFeatures | test_delete_face, test_clean_up |
| revolve_feature.py, hole_feature.py, joints.py | 704 | fundacad-geom::features::{revolve,hole,joint} | medium | test_revolve_axis, test_thread_revolve, test_joint |
| projection.py, projection_refresh.py | 528 | fundacad-geom::projection (HLRBRep bridge) | medium | test_silhouette, test_refresh |
| mesh_import.py, import_feature.py, step_assembly.py | 1,621 | fundacad-geom::import (STEPCAF + XCAF, RWGltf, stl_io/tobj) | high | test_assembly, fixtures/asm_*.step |
| exporters.py, export_tree.py | 202 | fundacad-geom::export::step | medium | STEP re-read round trip |
| inspect_model.py | 249 | fundacad-geom::inspect | low | MCP tests |
| rebuild_cache.py, geomstore.py | 1,104 | fundacad-geom::cache | medium | test_checkpoint, test_geomstore |
| shape_generate.py, plugin_geometry.py | 624 | fundacad-geom::plugins (wasmtime host) | design | test_fasteners |
| server.py | 2,139 | fundacad-engine | medium | test_ws, test_cancel, test_conn_limit, test_fullstack, test_heartbeat |
| tools/*.py evals | 4,169 | stay Python, drive the engine through the CLI or `--ws` | low | they are the oracle |

OpenCASCADE classes the vendored bridge does not expose yet, in order of first
use: `ShapeFix_Shape/Face/Solid/Wire`, `BOPAlgo_Splitter`,
`BRepAlgoAPI_Splitter`, `BOPAlgo_RemoveFeatures`, `BRepOffset_MakeOffset` (3D),
`BRepOffsetAPI_DraftAngle`, `HLRBRep_Algo` + `HLRBRep_HLRToShape`,
`STEPCAFControl_Reader/Writer` + `XCAFDoc_ColorTool`, `RWGltf_CafReader`,
`BRepExtrema_DistShapeShape`, `GCPnts_QuasiUniformDeflection`,
`ShapeCustom_Surface`, `BinTools` V3 pinning, `OSD_ThreadPool`. Each is one
`#[cxx::bridge]` file plus a `wrapper.hxx` shim in
`third_party/opencascade-rs/crates/opencascade-sys/src`.

### 4.2 TypeScript mirrored in `fundacad-core`

The TypeScript stays; these get a Rust twin and shared vectors.

| Source (src/) | LOC | Rust twin |
|---|---|---|
| types.ts | 720 | fundacad-core::schema |
| document/migrate.ts | | fundacad-core::migrate (only what the engine must read) |
| params/* | 958 | fundacad-core::params (expression evaluation) |
| sketch/pattern.ts, region.ts, faceFootprint.ts, features/patternMath.ts, holeStandards.ts | 1,470 | fundacad-core |
| document/faceColors.ts, bodyIds | | fundacad-core |

### 4.3 TypeScript that changes

| Source (src/) | Change |
|---|---|
| geometry/client.ts | transport interface, WebSocket and Tauri IPC implementations |
| geometry/tauriClient.ts | deleted (spike) |
| app/engine.ts | picks the transport; `VITE_GEOM` removed |
| components preferences | developer setting for the engine until cutover |

### 4.4 Deleted, not ported

`sidecar/` as a whole after cutover, `scripts/build-sidecar-runtime.{sh,ps1}`,
`src-tauri/src/sidecar.rs`, `src-tauri/src/geom.rs` (spike, tests moved),
`font_guard.py`, the `python-build-standalone` download and every `uv` step in
`.github/workflows/build.yml`.

## 5. Test strategy

- **Nothing red, ever.** The Python engine is the reference until it is
  deleted, and it is deleted in one commit, not eroded.
- **Differential oracle.** `sidecar/tools/` holds frozen corpora:
  `corpus_fillet.json` (500 cases), `corpus_selectors.json` (220),
  `golden.json` (13 documents), `bench/rebuild_baseline.json`.
  `diff_engines.py` drives both engines over the same documents and compares
  body count, per-body volume (rel 0.005), bbox (abs 1e-4) and the error list.
- **Protocol conformance.** The Python protocol suites take the server command
  from `FUNDACAD_ENGINE_CMD`; CI runs them against both engines. A suite that
  needs an op the engine under test has not got yet fails, unless
  `FUNDACAD_SKIP_UNPORTED_OPS=1` is set, which prints every case it skips. The
  engine answers a `testSleep` job under `FUNDACAD_ENGINE_TEST_OPS=1` and takes
  its clocks from `FUNDACAD_STALL_TIMEOUT` and `FUNDACAD_JOB_TIMEOUT`, so
  `test_cancel.py` has something long to cancel and `test_heartbeat.py` can
  watch a reap without waiting a minute for one.
- **Kernel tests in Rust.** `cargo test -p fundacad-geom` runs real
  OpenCASCADE tests from the first brick on.
- **CI.** The `rust-geom` job caches `target/OCCT` and runs
  `cargo test --workspace --features fundacad-engine/ws`, so the transport the
  Python suites drive is compiled and tested; it gates once Phase 1 step 4 lands.
- **Hygiene.** `scripts/check-repo-hygiene.sh` applies to Rust too.

## 6. The `prealpha-rust-ver` rolling release

A second rolling release beside `beta`, built by a job cloned from `release`
with its own `concurrency.group`, its own tag moved in place and the same asset
sweep. Differences:

- The Rust engine is the default engine and the `sidecar-runtime` resource is
  not bundled.
- Title: `FundaCAD pre-alpha, Rust engine (rolling, WORK IN PROGRESS)`.
- Release notes open with a warning that is not optional: the Rust engine is
  incomplete, features listed as unported fail in a rebuild with the
  skipped-feature banner, files saved by it open in the beta, plugin geometry
  does not run, and it is not for real work.
- No `latest.json`, so the updater never moves a beta install onto it.
- Version `0.3.<run number>-rust`.

## 7. Working agreements for the branch

- Branch: `rustirisation`. Each brick keeps every suite green.
- Agents: research, surveys and docs on Sonnet; code that lands in the tree,
  and its review, on Opus.
- No em or en dashes anywhere, a comma instead (house style and CI gate).
- Rust doc comments say why; a module names the Python module it replaces in
  its header until the Python is deleted.
- OpenCASCADE classes are added to the vendored bridge, never reached through
  `unsafe` shims in application crates.
- `unwrap` is for tests. Engine errors carry the feature id so the frontend
  banner keeps working.
- Building on Windows: use the rustup MSVC toolchain (a MinGW `cargo` earlier
  on PATH picks the MinGW Makefiles generator) and set
  `CMAKE_POLICY_VERSION_MINIMUM=3.5`, CMake 4 refuses OCCT 7.8.1's minimum.
