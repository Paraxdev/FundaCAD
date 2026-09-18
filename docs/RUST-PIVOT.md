# The Rust pivot ("rustirisation")

Status: done, phase 3 landed on 2026-09-18. The Rust engine is `main` and
ships as the rolling 1.0 alpha; the Python engine and its sidecar are gone from
`main` and live on the `legacy` branch, which keeps publishing the beta. This
document is the plan, the decision record and the conversion target list the
move was executed from, one brick at a time, every brick leaving every test
suite green. The Python paths it names are on `legacy`.

Related: [ARCHITECTURE.md](ARCHITECTURE.md) (what exists today),
[PROTOCOL.md](PROTOCOL.md) (the wire contract the new engine must honour),
[FUNDA-FORMAT.md](FUNDA-FORMAT.md) (already Rust), [PLUGINS.md](PLUGINS.md).

## 1. The decision

FundaCAD stays a Tauri 2 application with a Vue 3 + three.js frontend, for
good. Everything behind the frontend becomes Rust: geometry, tessellation,
document rebuild, file formats, import and export, the MCP server. The Python
sidecar, its bundled interpreter and the `uv` toolchain were deleted at the end.

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
- The file formats are already Rust, the `fundacad-format` crate.
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
  MCP live session reaches a running app through a loopback endpoint with the
  same gate that the WORKER opens beside its stdio pipe (`FUNDACAD_LIVE_TOKEN`
  from the app, `LISTENING <port>` back on stderr), serving the same engine
  and so the same live session; the main process publishes it in
  `session.json`. No relay: a guest's frames never pass through the window.
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
  fundacad-mcp       the MCP server on rmcp, part of the app (docs/MCP.md).
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
  manifest keys stay, so documents do not change. The host is in, the second
  manifest key `geometryWasm` names the component, and a plugin that ships
  only the Python half runs on the Python engine alone until it is ported.

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
  `displace` (a component keeps no state between calls, so what Python keeps
  in a module global between the two travels there), and `displace` reads the
  face's stored triangulation, with `split-creases` on for the viewport only.
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
  rotation, booleans plain or with build123d's options (parallel, a fuzzy
  value or the picked-geometry one, cleaned), unify, fillet and chamfer with
  the one-edge-at-a-time fallback, face selectors resolved against any shape,
  and the Delaunay triangulation of planar points exactly as
  `scipy.spatial.Delaunay` makes it (Qhull 2020.2, vendored in
  `third_party/qhull`, same options, same facet walk); the blob store; a
  feature context (the feature JSON, parameter values, selector picks grouped
  by body, body shapes in and out, diagnostics, mesh pass specs);
  `output.write` for an exporter, to a path the host chose; `numeric`, the
  engine's own C math library, so a plugin's sines and powers round as the
  Python half's do on the same machine; `files` reads, only for a manifest
  that grants `files.read`; and `cancelled`, `progress`, `log`. A kernel
  refusal a plugin hands on unchanged keeps its error code.
- **Sandbox:** WASI with no preopened directories, no environment, no
  arguments and sockets refused; files only through `files`, read only, and
  only with the grant; a `StoreLimits` memory cap of 1 GiB;
  epoch interruption on a 20 ms tick with the same budgets the Python engine
  gives a job, 60 s per feature and per mesh pass, 180 s for `generateShape`;
  cancellation polled in the same callback, so a cancel stops a plugin mid
  loop. A trap poisons nothing: every call gets a fresh instance, so no state
  survives a call and a crashed plugin costs one feature.
- **Discovery** reads the manifests under `FUNDACAD_PLUGIN_DIR` (a checkout's
  own `plugins/` in a debug build), explicitly, from the engine's startup path
  only, as `server.py` calls `plugin_geometry.discover()`: a bare
  `builder::rebuild` has no plugins and an unknown type reads "unknown feature
  type", exactly as the Python builder alone does. A component is compiled the
  first time one of its declared names is used, and the three sentences of
  `unregistered()` (absent, installed but broken, unknown) are kept.
- **Proof:** every in-repo plugin's geometry is ported, each crate in its
  plugin's `geometry-rs`, and each checked on both engines:
  - PrintToolbox, eight feature types: `tests/golden/corpus/corpus_plugins.json`, 40
    documents through `diff_engines.py`, volumes and refusals alike.
  - Screws, the `fastener` generator with its modelled threads on the kernel's
    helical sweep: `corpus_screws_ops.json`, 127 `generateShape` cases (every
    catalogue family at both ends of its table, the threads, drives and
    refusals) through `diff_plugin_ops.py`: solids, validity and face counts
    exact, volumes to 1e-6, the preview mesh vertex for vertex, and a stored
    blob rebuilt as an import.
  - Printing, the slicer project exporter, with the person's slicer presets
    read through `files`: `corpus_printing_ops.json`, 14 `exportWith` cases
    compared entry by entry inside the zip.
  - Texture, the feature and its mesh pass: `corpus_texture.json`, 84
    documents (every kind, every control, planes, cylinders, cones, spheres,
    fillet corners, images, grime, several bodies, refusals) through
    `diff_engines.py` and `diff_meshes.py`, which holds the meshes to the same
    triangles per face, every vertex and triangle to 1e-5 of the other
    engine's, the normals to 1e-4, the export, and the etags (stable on an
    identical rebuild, changed with the texture). They agree triangle for
    triangle. What makes that possible is recorded in the crate: numpy's
    pairwise sums and its row by row axis-0 reductions, its float `%`,
    `round`, `arange` and `unique`, PCG64 and SeedSequence for the noise
    table, Qhull for every Delaunay, and the platform libm for every
    transcendental. The last two cannot be anything else: Qhull breaks a
    co-circular tie by its own insertion order, and one ulp of a cosine moves
    such a tie. What stays apart: numpy's `lstsq` (LAPACK) and the port's QR
    agree to rounding, which only shows in the normal of a triangle with no
    area; and a JPEG heightmap's decoder (libjpeg-turbo there, zune-jpeg here)
    may round a pixel one level differently.
  - MultiColor, ExtraParameters and SpaceMouse have no engine geometry.

- **Shared algorithms:** the TypeScript copies stay (the frontend needs them
  synchronously for previews); the Rust twin is ported from the TypeScript,
  not from Python, and both run the same JSON test vectors under
  `tests/vectors/`. Compiling `fundacad-core` to wasm for the frontend is an
  option if the vectors ever fail to keep them in step, not a plan.
- **Sketch solver:** unchanged, the frontend keeps the PlaneGCS wasm. The
  engine never solves sketches; it builds what the document stores.
- **Text:** glyph outlines from `ttf-parser` plus system font discovery with
  `fontdb`, not `Font_FontMgr`; the outline is converted to OCCT edges by us.
  Landed in `fundacad-geom::text`, measured against the Python engine by
  `tests/text_oracle.rs`. Single stroke fonts (build123d's bundled "Relief
  SingleLine CAD" and its `offset_2d` ribbon) are the one piece left out: the
  font is not ours to ship, so `singleline` resolves like any unknown family.

## 3. Phases

Each phase ended with every suite green: vitest, the sidecar and plugin Python
tests (until the sidecar was deleted), `cargo test` across the workspace, the
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
7. The `alpha` rolling release (section 6). Done.

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
   checkpoint cache, mesh artifact cache. `fundacad-geom::cache` keeps the
   sidecar's chain keys and its two tiers, and drops the SQLite index: every
   lookup geomstore makes is by chain key, so a `checkpoints/<key>.json`
   answers it in one stat, the rename that publishes a blob publishes a record
   the same way, and a record's mtime is its last access. Eviction and Compute
   All read the records once, which they did over the index anyway. The engine
   binary's size and mtime stand in for the sidecar's source hash in `env_sig`.
5. Import (BREP, STEP with XCAF colours and assemblies, STL, 3MF, OBJ, GLB) and
   export (STEP, STL, 3MF with colours, GLB), `inspect`, `interference`,
   `projectGeometry`, `tessellateText`, `listFonts`, `migrateGeometry`.
6. Plugin host (section 2.3, in) and the in-repo plugins' geometry ported to
   wasm components: PrintToolbox, Screws, Printing and Texture are ported
   (section 2.3, Proof).
7. `fundacad-mcp` on rmcp, same tool vocabulary (docs/MCP.md). Done: the two
   servers publish a byte-identical tool list, the eleven Python suites have
   Rust twins, and `crates/fundacad-mcp/tools/diff_servers.py` runs a scripted
   session through both and diffs the replies. It does not link the kernel: a
   private session spawns `fundacad-engine --ws`, which is the same socket a
   live session uses. MCP left the plugin system for 1.0: the server ships
   beside the app, Preferences has a core MCP section, and the Python server
   moved to `crates/fundacad-mcp/tools/python-oracle/`, the parity oracle, which
   is deleted with the sidecar.
8. Gates: `eval_fillet_corpus` 0/500, `e2e_coverage.py` 34/34, the golden
   corpus, and the Python protocol suites (`test_ws.py`, `test_cancel.py`,
   `test_conn_limit.py`, `test_fullstack.py`) run against
   `fundacad --engine --ws` through a `FUNDACAD_ENGINE_CMD` variable.

### Phase 3, cutover (done)

1. The branches moved instead of a default flipping: `main` became the Rust
   engine and publishes the `alpha`, and the Python engine went to `legacy`,
   which publishes the `beta` (section 6).
2. Every differential check against Python was frozen as a golden file
   (section 5.1) and the Python engine's answers are checked on every push.
3. Then `sidecar/` was deleted from `main` in one commit, with
   `scripts/build-sidecar-runtime.*`, `src-tauri/src/sidecar.rs`, the
   WebSocket client's token fetch from Tauri, every `uv` step in CI, the
   Python MCP server, every plugin's Python geometry and its `geometry`
   manifest key, and the `sidecar-runtime` bundle resource. The `rust-engine`
   cargo feature went with them: the Rust engine is the app's only engine,
   `tauri.conf.json` carries the alpha feed and a policy with no loopback
   origin, and `tauri.alpha.conf.json` is only the release bundle settings.
   What the Python tree held that the Rust side still needed moved first: the
   STEP fixtures and the bench document to `tests/fixtures/`, the selector
   tuning beside `fundacad-geom::select`, the hole tables to
   `tests/vectors/hole_standards.json`, and `src-tauri/tests/container_seam.rs`
   now drives an engine import through the app's container.
4. `fundacad-format` and `fundacad-cli` extracted; the three gated evals ported
   to the CLI (`select-eval`, `fillet-eval`, `golden-check`).

## 4. Conversion targets

The record of what was ported from where. LOC were `wc -l` of the tree before
the port; the Python sources named here are on the `legacy` branch. "Oracle"
is what proved the port right.

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
| shape_generate.py, plugin_geometry.py | 624 | fundacad-geom::plugins (wasmtime host, done) | design | corpus_plugins.json, corpus_screws_ops.json, corpus_printing_ops.json, corpus_texture.json, tests/plugin_host.rs, tests/qhull_parity.rs |
| server.py | 2,139 | fundacad-engine | medium | test_ws, test_cancel, test_conn_limit, test_fullstack, test_heartbeat |

### 4.1b The Python MCP server (was the FundaCAD.MCP plugin)

| Source (crates/fundacad-mcp/tools/python-oracle/) | LOC | Target | Risk | Oracle |
|---|---|---|---|---|
| server.py | 1,498 | fundacad-mcp::{server,upload} | medium | tests/{protocol,import}.rs |
| schema.py | 758 | fundacad-mcp::schema (+ schema.json) | low | tests/schema.rs, held to `Feature::KNOWN` |
| render.py | 453 | fundacad-mcp::{render,png} | low | tests/render.rs, the same pixel counts |
| sidecar_link.py, winjob.py | 499 | fundacad-mcp::link | medium | tests/{engine_discovery,lifetime}.rs |
| model.py | 369 | fundacad-mcp::model | low | tests/model.rs |
| expr.py | 339 | deleted, fundacad-core::params | low | tests/expr.rs |
| docfile.py | 293 | fundacad-mcp::docfile | low | tests/docfile.rs |
| live_link.py, app_session.py | 330 | fundacad-mcp::{live,app_session} | medium | tests/{live_session,reattach}.rs |
| describe.py | 130 | fundacad-mcp::describe | low | tests/protocol.rs |
| client.py | 197 | stays Python, drives either server | low | it is the diff harness |
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

- **Nothing red, ever.** The Python engine was the reference until it was
  deleted, and it was deleted in one commit, not eroded.
- **Differential oracle, frozen.** While both engines existed, the Python
  diff tools (`diff_engines.py`, `diff_meshes.py`, `diff_plugin_ops.py`, the
  fillet and selector evals, `e2e_coverage.py`) drove both over the same
  corpora and compared body count, per-body volume (rel 0.005), bbox (abs
  1e-4) and the error list. Their answers are the golden files of section 5.1,
  and the corpora are in `tests/golden/corpus/`.
- **Protocol conformance.** The Python protocol suites (`test_ws.py`,
  `test_cancel.py`, `test_conn_limit.py`, `test_fullstack.py`,
  `test_heartbeat.py`) ran against `fundacad-engine --ws` before the deletion;
  their Rust twins are `crates/fundacad-engine`'s own tests. The engine answers
  a `testSleep` job under `FUNDACAD_ENGINE_TEST_OPS=1` and takes its clocks from
  `FUNDACAD_STALL_TIMEOUT` and `FUNDACAD_JOB_TIMEOUT`, so a cancel test has
  something long to cancel and a reap can be watched without waiting a minute.
- **Kernel tests in Rust.** `cargo test -p fundacad-geom` runs real
  OpenCASCADE tests from the first brick on.
- **Shared vectors.** A TypeScript mirror and its Rust twin both read one file
  under `tests/vectors/` (body ids, face colours, hole standards, parameters),
  recorded from the Python engine before it was deleted.
- **CI.** The `rust-geom` job caches `target/OCCT`, runs
  `cargo test --workspace --features fundacad-engine/ws`, every golden check,
  and the app shell's tests (`src-tauri`, including the container seam); it
  gates the alpha build.
- **Hygiene.** `scripts/check-repo-hygiene.sh` applies to Rust too.

### 5.1 Golden files

`tests/golden/*.golden.json` are the Python engine's answers, frozen once by
`freeze_goldens.py` (on `legacy`, in `sidecar/tools/`) while it still existed, one file per
corpus, holding exactly what each differential tool compared and the
tolerances it used. The corpora they answer are in `tests/golden/corpus/`.
Each header records the build123d, OCP and commit they came from. They live
at the repository root rather than in a crate because they span the CLI, the
geometry crate and the MCP server, and outlive the engine that wrote them.

`fundacad-engine golden-check tests/golden/<name>.golden.json` rebuilds the
corpus on the Rust engine, in process, and compares with the same rules,
printing the diff tool's table and exiting 1 on any mismatch;
`crates/fundacad-mcp/tests/parity_golden.rs` replays `parity.jsonl` against the
Rust MCP server and wants the recorded transcript word for word. CI runs both
in the `rust-geom` job.

- **A deliberate behaviour change** in the Rust engine that moves a golden
  answer updates that golden in the same commit, with the reason in the commit
  message. There is no Python engine left to ask: re-record the named case
  with `golden-check <golden> --record <case>` (or edit the value by hand),
  and review the diff, which touches only that case.
- **A new corpus document** has no Python answer. Add it to the corpus, look at
  what the Rust engine does with it (in the app, or measured by hand), and only
  then run `golden-check <golden> --record <name>`, which writes this engine's
  answer in the same shape, updates `corpusSha256` and lists the case under
  `rustRecorded` in the header. That case is a regression check against a
  human judgement, not parity with the old engine, and the commit says so. The
  coverage golden's constants are the tool's own arithmetic, not answers, and
  are edited by hand.

## 6. The `alpha` rolling release (landed)

Renamed from `prealpha-rust` on 2026-09-18, when the branches moved: the Python
engine lives on the `legacy` branch, which keeps publishing the rolling `beta`
release and `beta/latest.json` from its own copy of `build.yml`, and the Rust
engine is `main`, which publishes this rolling `alpha`. Alpha rather than beta
because the Rust engine is the less tested of the two. Since phase 3 the
workflow on `main` has no beta jobs at all.

A second rolling release beside `beta`, on the tag `alpha`. Two jobs in
`.github/workflows/build.yml`, `build-alpha` and `release-alpha`, with
their own `concurrency.group` (`release-alpha`), their own rolling tag
moved in place rather than deleted, their own `latest.json` and the same
old-asset sweep. What makes the bundle:

- The engine is a worker process of the same executable, reached over Tauri
  IPC (`src/geometry/transport.ts`). Until phase 3 this was the `rust-engine`
  cargo feature; it is now the only build.
- `src-tauri/tauri.alpha.conf.json` on top of `tauri.conf.json` for the
  release bundle settings and the MCP server beside the app. Neither declares
  a resource, so no Python runtime can be bundled, and the job checks the
  finished binary for the `engine_attach` command and the bundles for any
  Python interpreter, so what shipped is a fact about the bytes rather than
  about the arguments.
- Title: `FundaCAD 1.0 alpha, Rust engine (rolling)`.
- Release notes open with the warning, which is not optional: this is the new
  Rust engine and less tested than the beta, anything that builds differently
  from the beta is worth a report, plugin geometry runs only for plugins that
  ship a WebAssembly component (PrintToolbox so far), the beta continues on
  the Python engine from `legacy`, and files open in both.

### 6.1 The updater endpoint

**Decided: its own feed, at its own endpoint, baked into its own build.** The
draft above said "no `latest.json`, so the updater never moves a beta install
onto it". That answers the danger and loses the feature, and a rolling build
that cannot roll is one people install once and never update again.

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

`1.0.<run number>`: the Rust engine is the major upgrade, so it is 1.0 (the
base version in `package.json`, `src-tauri/Cargo.toml` and
`src-tauri/tauri.conf.json` is `1.0.0`), and the title says `FundaCAD 1.0
alpha`. It was `0.3.<run number>` while the channel was the pre-alpha.

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
talks to the Python engine over a loopback WebSocket; this engine is a stdio
worker reached over Tauri IPC, so the webview never opens a socket. Until
phase 3 the alpha config carried the tightened policy over a base that still
granted the socket; the base policy is now the tightened one, and
`tests/security/csp.test.ts` pins it.

### 6.4 Before the first alpha release is cut

- The `build-alpha` job has never run. It compiles OpenCASCADE from source
  on all three runners, about twenty minutes cold, cached at
  `src-tauri/target/OCCT`; the Linux leg installs `cmake`, which
  `.github/actions/linux-deps` deliberately leaves out.
- The updater is still off everywhere. `tauri.conf.json` carries upstream's
  minisign pubkey, so both release jobs withhold `latest.json` and say so in
  the notes. Generating a keypair turns both feeds on at once.
- Plugin bundles ARE published to this release, packed by `build-alpha` with
  their geometry components and nothing else, and the app installs from it
  (`RELEASE_TAG` in `src/plugins/index.ts`). Every plugin in the repository
  ships a component. The beta and the alpha share one plugin directory on a
  machine that has both, and a bundle the alpha installed has no Python half,
  so the beta cannot build that plugin's features until the beta's own bundle
  is installed again.
- `fundacad-mcp` ships beside the app (`externalBin`), its private engine is
  the app started with `--engine --ws`, and the app's worker serves a loopback
  WebSocket beside its stdio pipe for live sessions (docs/MCP.md).

## 7. Working agreements for the branch

- Branch: `rustirisation`, then `main`. Each brick keeps every suite green.
- Agents: research, surveys and docs on Sonnet; code that lands in the tree,
  and its review, on Opus.
- No em or en dashes anywhere, a comma instead (house style and CI gate).
- Rust doc comments say why. A module named the Python module it replaced in
  its header until the Python was deleted; those names are gone with it.
- OpenCASCADE classes are added to the vendored bridge, never reached through
  `unsafe` shims in application crates.
- `unwrap` is for tests. Engine errors carry the feature id so the frontend
  banner keeps working.
- Building on Windows: use the rustup MSVC toolchain (a MinGW `cargo` earlier
  on PATH picks the MinGW Makefiles generator) and set
  `CMAKE_POLICY_VERSION_MINIMUM=3.5`, CMake 4 refuses OCCT 7.8.1's minimum.

## 8. Performance

The Python engine was one job per process (`ProcessPoolExecutor(max_workers=1)`)
with OCCT's own thread pool inside BRepMesh and BOPAlgo, and helper processes
for the payload loop of a large import. The Rust engine keeps the kernel where
it is and fans the passes above it across cores instead.

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
| `import <file.step>` | import, rebuild, the payload loop, the binary frame and an STL and 3MF export, the shape of `sidecar/tools/bench_import.py` |
| `export <file.funda> [formats]` | the writers on their own |
| `faces <document>` | face bands and the body payload per shape |
| `smooth <document\|file.step>` | the batched smooth edge test against the per sample walk it replaced, edge by edge |
| `digest <document\|corpus.json\|file.step>` | the whole reply frame as a digest, to compare a serial run with a parallel one |

`FUNDACAD_BENCH_PHASES=1` adds a phase table (`crate::bench`), the Rust side of
`bench_import.py`'s `_timed`. `FUNDACAD_THREADS` caps both the engine's rayon
pool and OCCT's, the sidecar's `VERXA_THREADS`.

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
  growing body, which is what the Python engine does; a balanced tree would
  give a different face order, so different etags and selectors.
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
byte's slot up front and `Message` carrying that layout, which changes the type
the Python protocol suites drive; not worth it for the size of the win.

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
- **Displacement mesh passes** (the Texture plugin, not ported yet) are the one
  genuinely GPU shaped stage: a procedural field evaluated over millions of
  vertices with no topology. But a displaced mesh feeds the export and the
  etag, and GPU float results are not reproducible across vendors, drivers or
  shader compilers (contraction, fast math, different transcendental rounding).
  A model would export differently on two machines.

Cost: wgpu and naga are around sixty crates, and a GPU path needs a CPU
fallback anyway for headless CI, virtual machines and driver loss. Two paths
that must agree bit for bit is the opposite of the rule this section opens
with.

**Recommendation: no GPU in the engine.** The time that is left is OCCT's (the
STEP read, BRepMesh, the section blend), none of it GPU shaped, and everything
above OCCT is now either parallel or under a second. The GPU the product
already uses is three.js in the viewport, which is where anything purely visual
belongs.
