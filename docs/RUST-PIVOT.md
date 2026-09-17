# The Rust pivot ("rustirisation")

Status: pre-alpha, work in progress. This document is the plan, the decision
record and the conversion target list for moving FundaCAD from three languages
(Python geometry sidecar, TypeScript/Vue frontend, Rust shell) to Rust. It is
written to be executed one brick at a time by whoever picks up the
`rustirisation` branch, human or agent, and every brick must leave every
existing test suite green.

Related: [ARCHITECTURE.md](ARCHITECTURE.md) (what exists today),
[PROTOCOL.md](PROTOCOL.md) (the wire contract the new engine must honour),
[FUNDA-FORMAT.md](FUNDA-FORMAT.md) (already Rust), [PLUGINS.md](PLUGINS.md).

## 1. The decision

There were two candidate end states:

- **A, complete pivot.** One Rust binary: egui + wgpu (Vulkan, Metal, DX12
  through wgpu) shell, Rust geometry on OpenCASCADE, no webview, no Python, no
  Node.
- **B, Rust backend, HTML frontend.** Tauri 2 shell kept, Vue + three.js UI
  kept, all geometry, mesh generation, document logic, file formats and the MCP
  server in Rust, the Python sidecar deleted.

**The plan is B first, with A built on the same crates as the pre-alpha
channel, and the switch to A decided by measured parity, not by fiat.**

Why not jump straight to A:

- The UI is the largest and most polished part of the product: 75k lines of
  TypeScript and Vue, 63 Vue components plus 16 in plugins, 38 distinct panels
  and dialogs, 60 browser end-to-end scripts, 225 vitest files. The renderer
  alone is 12.5k lines with four pieces that have no off-the-shelf wgpu
  equivalent (fat instanced edge lines, the triplanar procedural PBR surface,
  stencil-parity section caps, bloom and depth of field post).
- egui is usable now (0.36, wgpu 30, egui_tiles or egui_dock for docking,
  AccessKit on by default, harfrust text shaping, IME reworked in 0.35), but
  an immediate-mode toolkit is still the weaker fit for a dense CAD UI with
  many text inputs, trees, modals and plugin-contributed panels. iced 0.14 is
  the credible alternative (Open CAD Studio ships on it). Either is months of
  UI work that produces nothing a user cannot already do.
- A Tauri window cannot host a wgpu surface portably (works on Windows and
  macOS with strict invariants, not on Linux WebKitGTK), so "keep Vue, render
  in wgpu" is not a middle road. The middle road is the crate layering below.

Why B is worth doing on its own, immediately:

- The Python runtime is ~800 MB of the installer and the reason the app is
  three processes with a fixed port, a shared token, a stall supervisor and a
  crash classifier. In-process Rust geometry deletes `sidecar.rs`, the port,
  the token, `session.json` as a transport, the `sidecar-runtime` packaging
  scripts and the whole `uv` toolchain from the build.
- The seam is already drawn. `GeometryBackend` in `src/geometry/client.ts` is
  the only thing the frontend depends on, and `src/geometry/tauriClient.ts`
  shows the in-process version is 102 lines. Fourteen test files stub that
  interface by hand today.
- The file formats are already Rust (`fnda.rs`, `container.rs`,
  `json_doc.rs`). The document model, the parameter engine and the schema
  (`src/document`, `src/params`, `src/types.ts`, 5.9k lines) import neither
  three.js nor Vue.
- About 1,700 lines of algorithms are deliberately duplicated between TS and
  Python (pattern expansion, region detection, face footprints, hole
  standards, face colour encoding) to keep preview and build in agreement.
  One Rust implementation used by both sides removes a whole class of "preview
  disagrees with build" bugs.

What the HTML frontend keeps giving us while it stays: plugin panels written
in Vue, CSS theming, mature text input and accessibility, a dev loop that is
`npm run dev`, and the ability to run the whole UI headless in vitest. Those
are the "perks" the question was about, and they are real. They are given up
only when the native shell can show, in the same e2e scripts, that it lost
nothing.

## 2. Target architecture

One Cargo workspace at the repository root (`Cargo.toml`). The shells are thin
and swappable; everything they share is a library crate.

```
crates/
  fundacad-core      document schema, parameters and expressions, migrations,
                     body ids, face colours, pattern expansion, region
                     detection, undo model. Pure Rust, no kernel. Also built
                     to wasm so the Vue frontend can call the SAME code the
                     engine uses (ends the TS/Python mirrors).
  fundacad-geom      the geometry engine on OpenCASCADE: feature handlers,
                     selectors, blends, booleans, tessellation, import and
                     export, caches. Replaces sidecar/*.py.   <- FIRST BRICK
  fundacad-sketch    PlaneGCS bound with cxx, sketch solve, dimensions.
                     Replaces the planegcs wasm and lets the CSP drop
                     'unsafe-eval'.
  fundacad-protocol  the wire shapes of PROTOCOL.md (JSON envelope, binary
                     frames, progress frames, delta ops), shared by the server
                     and the in-process client.
  fundacad-server    the sidecar replacement: a WebSocket server on
                     127.0.0.1:8765 with token + Origin checks, job lock,
                     cancel, stall watchdog, live session. Exists so the MCP
                     server, the e2e scripts and test_ws.py keep working
                     unchanged, and for a headless engine.
  fundacad-format    fnda.rs, container.rs, json_doc.rs moved out of
                     src-tauri so both shells and the CLI share them.
  fundacad-mcp       the MCP server on rmcp (official Rust SDK), replacing
                     plugins/FundaCAD.MCP/*.py. Same tool vocabulary
                     (docs/MCP.md, src/plugins/broker/ops.ts).
  fundacad-native    the egui + wgpu shell. Viewport (offscreen wgpu pass with
                     its own depth, MSAA and picking, shown as an egui image),
                     timeline, browser tree, properties. Pre-alpha channel.
  fundacad-cli       headless build/export/inspect for CI, evals and scripts.
src-tauri/           the shipping Tauri shell, now a workspace member. Gains
                     an in-process engine (fundacad-geom) behind
                     `geom_rebuild` and friends, loses sidecar.rs.
third_party/opencascade-rs   vendored bindings (own workspace), extended
                     bridge by bridge as the port needs classes.
```

Kernel: OpenCASCADE 7.8.1, compiled statically from the `occt-sys` crate the
vendored bindings pull in (no system OpenCASCADE on any platform, no cmake in
the runtime, one C++ toolchain at build time). The Python engine today runs
OCCT 7.9.3 through OCP, so numerical results can differ in the last digits;
the differential harness (section 5) compares with tolerances, not bytes.
Upgrading the bindings to upstream opencascade-rs 0.3 (also 7.8.1) and later
to OCCT 8.0 is a tracked item, not a prerequisite.

Rendering in the native shell: wgpu 30 with the Vulkan backend on Linux and
Windows, Metal on macOS, DX12 available; no code targets Vulkan directly. The
render features with no wgpu equivalent (fat lines, procedural surface,
section caps, post) are written as our own passes, listed in section 4.

## 3. Phases

Each phase ends with every suite green: vitest (225 files), the sidecar and
plugin Python tests (106 files, until the sidecar is deleted), `cargo test`
across the workspace, the geometry evals, and the two CI e2e scripts. A phase
that needs a suite red to make progress is planned wrong.

### Phase 0, the first brick (this branch, done)

- Root Cargo workspace with `src-tauri` and `crates/fundacad-geom` as members.
- `fundacad-geom` compiles and links OpenCASCADE 7.8.1 statically through the
  vendored bindings; `cargo test -p fundacad-geom` runs real kernel tests
  (box volume and area, boolean cut volume, per-face tessellation in the
  protocol v2 body payload shape).
- The vendored bindings gain `Shape::volume()` and `Shape::surface_area()`.
- This document and the handoff notes.

### Phase 1, the engine behind the existing protocol

Goal: `fundacad-server` can be started in place of `server.py`, the Vue app
does not know the difference, and the Python sidecar becomes a fallback that
is deleted at the end of the phase.

1. `fundacad-protocol`: port `wire.py` (JSON envelope, binary float buffers,
   16 MiB chunking, progress frames, cancel token) with tests taken from
   `tests/geometry/{assemble,chunkStream,client}.test.ts` fixtures.
2. `fundacad-core` schema: `CadDocument`, the 36 core feature types, sketch
   entities, constraints, patterns, selectors, plane specs, parameter
   definitions, migrations (`src/document/migrate.ts`). Serde with the exact
   JSON names of `src/types.ts`. Round-trip every fixture document in the
   repo.
3. `fundacad-geom` feature handlers in this order, each with a differential
   test against the Python engine on the same documents (section 5):
   primitives and move/scale/mirror/duplicate/removeBody; sketch (lines,
   arcs, circles, rectangles, polygons, slots, splines, regions); extrude
   and revolve; boolean and split; fillet and chamfer (plain circular first,
   then the conic and section-blend fallbacks); shell, thicken, offsetFace,
   draft, press-pull; hole; patterns; loft, sweep, imprint, deleteFace,
   cleanUp, simplifyMesh; joint, datums; import (BREP, STEP with XCAF colours,
   STL/3MF/OBJ/GLB) and export (STEP, STL, 3MF with colours, GLB).
4. Selectors (`geom_select.py`, `topo_adj.py`, `selector_tuning.json`) with
   `eval_selector_survival` run against the Rust resolver: gate is the same
   0.990 survival rate on the frozen 220-case corpus.
5. Tessellation and per-body payloads (`tessellate.py`, `viewport_mesh.py`):
   faceIds, faceOwners, edges, faceBands, normals, etags, tolerance tiers,
   density cap.
6. Caches: content-addressed blob store (blake2b-128, `.bbrep`, BinTools V3),
   prefix checkpoint cache, mesh artifact cache.
7. `fundacad-server`: token and Origin gate, job lock, `cancel`, stall
   watchdog (in Rust the worker is a thread with a heartbeat plus a
   crash-isolated child process for the two operations known to take the
   process down: `BRepOffset_MakeOffset` and the section blend), live session
   ops, `inspect`, `interference`, `listFonts`, `tessellateText`,
   `projectGeometry`, `migrateGeometry`, `generateShape`, `exportWith`.
8. Run the Python protocol suites against the Rust server: `test_ws.py`,
   `test_cancel.py`, `test_conn_limit.py`, `test_fullstack.py`,
   `e2e_coverage.py` (34/34), `golden_corpus.py`. They take the server
   command from an environment variable so the same files test both engines.
9. Ship the `prealpha-rust-ver` rolling release (section 6) as soon as step 3
   covers sketch + extrude + fillet + boolean + export, with the warning text.
10. Delete `sidecar/`, `scripts/build-sidecar-runtime.*`, `sidecar.rs`, the
    `uv` steps in CI, and the Python plugin geometry (section 4.4) once
    coverage is 34/34 and the golden corpus matches.

### Phase 2, in-process engine and shared core

1. `src-tauri` calls `fundacad-geom` directly through `geom_rebuild`,
   `geom_export` and one command per remaining op; `tauriClient.ts` becomes
   the default `GeometryBackend`. The WebSocket server stays for MCP and
   headless use.
2. `fundacad-core` compiled to wasm (wasm-bindgen) and used by the Vue app for
   pattern expansion, region detection, face footprints, hole standards, face
   colours and the expression parser. The TS copies and their Python twins are
   deleted; invariant 6 in ARCHITECTURE.md is retired.
3. `fundacad-sketch`: PlaneGCS through cxx (about a dozen C++ files plus
   Eigen), the sketch solve model of `solver.ts` and `sketchSolve.ts`, exposed
   to the Vue app as wasm and to the native shell natively. The planegcs npm
   package and `'unsafe-eval'` leave the CSP.
4. `fundacad-mcp` on rmcp replaces the Python MCP plugin; `.mcp.json` runs the
   binary.
5. `fundacad-format` extracted from `src-tauri`; `fundacad-cli` for CI.

### Phase 3, the native shell

1. `fundacad-native`: window, egui_tiles layout, wgpu viewport with the
   protocol v2 body meshes, orbit/pan/zoom with the camera rules of
   `cameras.ts` and `clipPlanes.ts`, picking that produces the same selector
   descriptors as `picking.ts`, timeline and browser tree over
   `fundacad-core`.
2. Feature tools one by one, in the order of the e2e scripts in `e2e/`, each
   reproduced as a native e2e (egui has an inspection protocol and
   `egui_mcp` for driving a live app).
3. Render look: fat lines (expanded quads, per-instance colour), triplanar
   procedural PBR, stencil section caps, bloom and depth of field, procedural
   environments.
4. Plugin panels: a native plugin ABI (section 4.4) for the UI half.
5. Parity gate: every e2e flow passes natively, memory and frame-time
   benchmarks match or beat `e2e/memory_e2e.cjs` and `browser_tree_perf.cjs`.
   Only then does the native shell become the default and the Tauri shell the
   legacy channel.

## 4. Conversion targets

LOC are `wc -l` of the current tree. "Oracle" is what proves the port right.

### 4.1 Python sidecar to `fundacad-geom` / `fundacad-server` / `fundacad-core`

| Source (sidecar/) | LOC | Target | Risk | Oracle |
|---|---|---|---|---|
| live_session.py | 188 | fundacad-server::live | low | tests/test_live_session.py, MCP test_live_session |
| face_colors.py | 117 | fundacad-core::face_colors | low | tests/document/faceColors.test.ts vectors |
| body_ids.py | 76 | fundacad-core::body_ids | low | tests/document/bodyIds.test.ts |
| pick_fuzz.py, plane_spec.py, errors.py, appenv.py, progress.py | 314 | fundacad-core / server | low | unit |
| sysmem.py | 130 | fundacad-server::sysmem (sysinfo crate) | low | unit |
| blobstore.py | 168 | fundacad-format::blobstore (already half in container.rs) | low | container_seam.rs |
| mesh_refine.py, mesh_writers.py | 426 | fundacad-geom::export::{stl,threemf,glb} | low | byte-compare with Python output on fixtures |
| wire.py | 455 | fundacad-protocol | low | vitest chunkStream/assemble fixtures |
| font_guard.py | 167 | deleted (no fontTools) | none | |
| occt_smp.py | 59 | OSD_ThreadPool config in fundacad-geom::kernel | low | |
| topo_adj.py | 177 | fundacad-geom::topo | low | test_topo_adj |
| shape_util.py | 686 | fundacad-geom::shape (BREP io, debris, unify, ShapeFix) | medium, needs ShapeFix bridge | test_smoke |
| tessellate.py, viewport_mesh.py | 1,328 | fundacad-geom::mesh (started) | medium | mesh volume/bbox invariants, faceIds count |
| face_plane.py, plane_spec.py | 229 | fundacad-geom::planes | low | test_datum_face |
| geom_select.py, selector_tuning.json | 1,087 | fundacad-geom::select | high | eval_selector_survival >= 0.990 |
| face_bands.py, face_footprint.py | 668 | fundacad-geom::faces | medium | test_face_bands, faceFootprint.test.ts |
| sketch_build.py | 870 | fundacad-geom::features::sketch (+ core pattern expansion) | medium, text needs Font_FontMgr or ttf-parser outlines | test_sketch_*, region tests |
| builder.py, handler_util.py | 1,809 | fundacad-geom::builder (timeline replay, no-op on failure) | medium | test_smoke, golden corpus |
| booleans.py | 906 | fundacad-geom::features::boolean | high | test_boolean*, test_sealed_void |
| blends.py, conic_blend.py, section_blend.py, blend_overlap.py | 3,277 | fundacad-geom::features::blend | highest | eval_fillet_corpus 0/500 failures, test_conic_blend, test_section_blend |
| solid_ops.py, offset_child.py | 827 | fundacad-geom::features::{presspull,shell,offset,draft,pattern} | high, crash isolation for BRepOffset | test_presspull, test_shell_wall |
| defeature.py, heal_snapped.py | 1,173 | fundacad-geom::features::defeature | high, needs BOPAlgo_RemoveFeatures bridge | test_delete_face, test_clean_up |
| revolve_feature.py, hole_feature.py, joints.py | 704 | fundacad-geom::features::{revolve,hole,joint} | medium | test_revolve_axis, test_thread_revolve, test_joint |
| projection.py, projection_refresh.py | 528 | fundacad-geom::projection (HLRBRep bridge) | medium | test_silhouette, test_refresh |
| mesh_import.py, import_feature.py, step_assembly.py | 1,621 | fundacad-geom::import (STEPCAF + XCAF bridge, RWGltf bridge, stl_io/tobj) | high | test_assembly (1,148 lines), fixtures/asm_*.step |
| exporters.py, export_tree.py | 202 | fundacad-geom::export::step (STEPCAFControl_Writer bridge) | medium | STEP re-read round trip |
| inspect_model.py | 249 | fundacad-geom::inspect | low | MCP tests |
| rebuild_cache.py, geomstore.py | 1,104 | fundacad-geom::cache (rusqlite or sled) | medium | test_checkpoint, test_geomstore |
| shape_generate.py, plugin_geometry.py | 624 | fundacad-geom::plugins (section 4.4) | design | test_fasteners |
| server.py | 2,139 | fundacad-server | medium | test_ws, test_cancel, test_conn_limit, test_fullstack, test_heartbeat |
| tools/*.py evals | 4,169 | keep in Python until the sidecar is gone, then port the three gated evals to fundacad-cli | low | they are the oracle |

OpenCASCADE classes the vendored bridge does not expose yet and the port
needs, in order of first use: `ShapeFix_Shape/Face/Solid/Wire`,
`BOPAlgo_Splitter`, `BRepAlgoAPI_Splitter`, `BOPAlgo_RemoveFeatures`,
`BRepOffset_MakeOffset` (3D), `BRepOffsetAPI_DraftAngle`,
`BRepOffsetAPI_MakeThickSolid` by join is there but sealed voids need the
outer minus inner path, `HLRBRep_Algo` + `HLRBRep_HLRToShape`,
`STEPCAFControl_Reader/Writer` + `XCAFDoc_ColorTool`, `RWGltf_CafReader`,
`Font_FontMgr` (or replace with ttf-parser outlines), `BRepExtrema_DistShapeShape`,
`GCPnts_QuasiUniformDeflection`, `ShapeCustom_Surface`, `BinTools` V3 pinning,
`OSD_ThreadPool`. Each is one `#[cxx::bridge]` file plus a `wrapper.hxx` shim
in `third_party/opencascade-rs/crates/opencascade-sys/src`.

### 4.2 TypeScript to `fundacad-core` (Phase 2, shared by both shells)

| Source (src/) | LOC | Target | Note |
|---|---|---|---|
| types.ts | 720 | fundacad-core::schema | serde, exact JSON names |
| document/migrate.ts, versions.ts, elements.ts, materials.ts, faceMaterials.ts, faceColors.ts, optionFields.ts, numFields.ts, missingPlugins.ts | 2,306 | fundacad-core::document | side-maps stay display-only (invariant 5) |
| document/store.ts | 1,890 | fundacad-core::store (command log instead of whole-document snapshots) | TS store becomes a thin wrapper in Phase 2, native store in Phase 3 |
| params/* | 958 | fundacad-core::params | expression parser first, cascade second |
| sketch/pattern.ts, region.ts, faceFootprint.ts, features/patternMath.ts, holeStandards.ts | 1,470 | fundacad-core (the mirrors) | deletes the Python twins |
| features/*Math.ts | 1,800 | fundacad-core::math | pure |
| sketch/solver.ts, sketchSolve.ts, entityDims.ts, headlessSolve.ts | 1,714 | fundacad-sketch | PlaneGCS via cxx |
| geometry/assembly.ts | 443 | fundacad-protocol::assemble | |
| io/documentExt.ts, exportSettings.ts, fundaInsert.ts, recentFiles.ts | 374 | fundacad-core::io | |
| live/liveSession.ts | 258 | fundacad-core::live (client half) | |
| input/shortcuts.ts | 156 | fundacad-core::shortcuts (one table, both shells) | invariant 7 |

### 4.3 TypeScript kept in the Tauri shell until Phase 3

| Source (src/) | LOC | Native replacement (Phase 3) |
|---|---|---|
| viewport/* | 12,498 | fundacad-native::viewport (wgpu) |
| features/*Tool.ts | ~13,600 | fundacad-native::tools |
| sketch/* minus the pure parts | ~10,000 | fundacad-native::sketch |
| components/*, ui/*, stores/*, composables/*, styles/* | ~21,500 | fundacad-native::ui (egui_tiles) |
| app/* | 2,636 | fundacad-native::app |
| plugins/* (sandbox, broker, contrib) | 3,963 | native plugin ABI |
| geometry/client.ts | 1,207 | fundacad-protocol client (only for the WebSocket path) |

### 4.4 Plugins

Today a bundle is TS + Vue + Python geometry. The Python half has no place in
a Rust engine. Decision:

- The four in-repo plugins with geometry (Texture 2,594 py lines, PrintToolbox
  1,082, Screws 704, Printing 341) are ours; their geometry moves into
  `fundacad-geom` as feature modules behind Cargo features, registered through
  the same `featureTypes` manifest keys so documents do not change. Texture's
  numpy/scipy/PIL work becomes ndarray/kiddo/image.
- The plugin geometry ABI for third parties becomes WebAssembly components run
  by wasmtime with a small host API (build a solid from parameters, displace a
  face triangulation, write an export). Until it exists, third-party geometry
  plugins are unsupported on the Rust engine and the release notes say so.
- The UI half of a plugin stays JS in the Tauri shell; the native shell gets
  its own contribution ABI in Phase 3.

### 4.5 Deleted, not ported

`sidecar/.venv`, `sidecar/uv.lock`, `scripts/build-sidecar-runtime.{sh,ps1}`,
`src-tauri/src/sidecar.rs` (849), `src-tauri/src/session_file.rs` as a token
transport (the MCP server links the engine or speaks the WebSocket with a
token it is handed), `font_guard.py`, the `@salusoft89/planegcs` dependency,
the `python-build-standalone` download, and every `uv` step in
`.github/workflows/build.yml`.

## 5. Test strategy

- **Nothing red, ever.** Every commit on the branch keeps vitest, the Python
  suites, `cargo test --workspace` and the evals green. The Python engine is
  the reference until it is deleted, and it is deleted in one commit at the
  end of Phase 1, not eroded.
- **Differential oracle.** `sidecar/tools/` already holds frozen, format
  agnostic corpora: `corpus_fillet.json` (500 cases), `corpus_selectors.json`
  (220), `golden.json` (13 documents), `bench/rebuild_baseline.json`. A new
  `sidecar/tools/diff_engines.py` drives both engines over the same documents
  and compares body count, per-body volume (rel 0.005), bbox (abs 1e-4) and
  the feature-error list. It runs in CI as soon as the Rust server exists.
- **Protocol conformance.** `test_ws.py` and friends gain a
  `FUNDACAD_ENGINE_CMD` environment variable naming the server to spawn; CI
  runs them twice.
- **Kernel tests in Rust.** `cargo test -p fundacad-geom` runs real OpenCASCADE
  tests from the first brick on. The existing 30 tests in `src-tauri/src/geom.rs`
  (never run in CI, the feature could not build there) move into the crate.
- **CI.** The `test` job adds `cargo test --workspace` with the static OCCT
  build cached by `swatinem/rust-cache` (the first build is long, later ones
  are incremental). The old `rust-geom-check` probe, which always exited 0,
  is replaced by a `rust-geom` job that runs the crate tests for real.
- **Hygiene.** `scripts/check-repo-hygiene.sh` applies to Rust too: no em or
  en dashes in comments, no tracked model files, no home directory paths, no
  `CLAUDE.md`/`AGENTS.md`. New workflow upload steps need `retention-days`
  of 7 or less or `tests/build/artifactRetention.test.ts` fails.

## 6. The `prealpha-rust-ver` rolling release

A second rolling release beside `beta`, built by a job cloned from `release`
with its own `concurrency.group` (`release-prealpha-rust-ver`), its own tag
moved in place, its own `gh release view/edit/create`, binaries uploaded
before any manifest, and the same asset sweep. Differences:

- Built with `--features rust-engine` and **no** `sidecar-runtime` resource.
- Title: `FundaCAD pre-alpha, Rust engine (rolling, WORK IN PROGRESS)`.
- Release notes open with a warning that is not optional: the Rust engine is
  incomplete, features listed in the notes as unported are silently skipped
  in a rebuild (the frontend shows the skipped-feature banner), files saved by
  it open in the beta, files from the beta may show missing geometry here,
  third-party geometry plugins do not run, and it is not for real work.
- No `latest.json` is published for this channel, so the updater never moves
  a beta install onto it; a user installs it on purpose.
- Windows portable zip only needs `fundacad.exe` (no Python tree), which is
  the point of the exercise.
- `retention-days: 1` on its upload step.

The version string is `0.3.<run number>-rust` so a bug report says which
engine it came from.

## 7. Working agreements for the branch

- Branch: `rustirisation`. One brick per pull request, each with its tests,
  each keeping every suite green.
- Agent model policy for the branch: general purpose research, surveys and
  document work run on Sonnet; code that lands in the tree is written and
  reviewed on Opus.
- No em or en dashes anywhere, a comma instead (house style and CI gate).
- Rust doc comments say why, as the Python modules do; the Python module a
  Rust module replaces is named in its header until the Python is deleted.
- OpenCASCADE classes are added to the vendored bridge, never reached through
  `unsafe` shims in application crates.
- `unwrap` is for tests. Engine errors carry the feature id (`errors.py`
  codes) so the frontend banner keeps working.
