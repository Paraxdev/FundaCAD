# FundaCAD 2: native and plastic

Status: direction agreed on 2026-11-26, the spike passed the same day (see Order of work, step 0). Supersedes the 2026-09 decision to keep Tauri and Vue.

## Why

FundaCAD 1 runs its UI in a webview. Every drag travels input, JS, Tauri IPC, stdio frame, engine, tessellation,
serialization and back before a pixel changes, and the webview is the biggest dependency we ship. A CAD program moves
meshes and vertices all day, which web technology handles badly. FundaCAD 2 drops Tauri and the web UI, keeps the
Rust engine, and keeps today's look exactly.

## Product: plastic parametric

Parametric CAD is stiff: you plan the timeline, declare intent upfront and fight the constraint solver. Direct
modelers flow but keep no history. FundaCAD 2 sits between them: a plastic feel, sketching that is freehand in 3D but
still precise, and a full history with parametrics underneath.

1. **Drag edits what it touches.** Pulling a face changes the parameter it comes from (Extrude 3 depth). If nothing
   maps cleanly, the drag adds a direct edit feature instead.
2. **Repeated drags merge.** Ten nudges are one timeline entry.
3. **A chip says what happened**, with one click to flip between "edited the original" and "added a direct edit".
4. **Intent comes after the fact.** Pin any measured value as a named parameter later. A snap made while drawing
   (midpoint, tangent, on face) becomes a soft relation that holds until you break it.
5. **Curves live in 3D.** No sketch mode: draw on any face or plane, closed regions are found and can be pulled. The
   timeline groups them into sketches quietly.

The niche on top is printing: live printability, fit clearances and the plugin ecosystem.

## Stack

| Layer | Choice | Note |
|---|---|---|
| UI toolkit | GPUI plus longbridge gpui-component | vendored fork, Zed reportedly paused GPUI as a standalone framework |
| Theme | Rust theme tokens ported from the SCSS | Space Grotesk and JetBrains Mono stay |
| Viewport | wgpu, shaders in WGSL | Vulkan on Linux and Windows, Metal on macOS, OpenGL fallback |
| Engine | the existing Rust crates | unchanged |
| Sketch solver | planegcs bound natively instead of wasm | |
| Plugins | wasm components with WIT contracts | wasmtime, already in the engine |
| i18n | the existing locale files | the lookup moves to Rust |

Rules:

- Our code is OS agnostic. Anything per OS lives behind one small trait in one crate.
- Our code never calls DirectX. Stock GPUI draws Windows with DirectX 11; our fork runs its wgpu renderer there too, so
  Windows and Linux share one renderer (Vulkan, GL fallback). The 3D view renders into a texture on GPUI's device and
  GPUI composites it like any other element.
- GPU floor is OpenGL 3.3 with the path tracer off. That takes a small patch to GPUI's wgpu device setup, and the
  viewport sticks to vertex buffers and uniforms there.
- The engine stays a supervised worker process, so an OCCT crash or a wedged fillet never takes the window down. Meshes
  move through shared memory instead of serialized frames. To be confirmed by the spike.

## Plugins

One versioned WIT package, `fundacad:plugin@1.x`, is the stable contract. WIT resources are the classes plugin authors
use. SDKs are generated from it for Rust, C# (componentize-dotnet, still preview) and TypeScript. Authors run their
normal build and get one `.wasm` for every OS. We build no compiler.

**Intent gates.** A component's imports are its capabilities, and the host links only the interfaces the user
granted, so the runtime enforces them, not trust.

- The manifest lists each intent with a reason, shown at install: "net: download thread tables from example.org".
- Grants are scoped: files only in chosen folders, network only to the listed hosts.
- Each version is pinned by its `.wasm` hash. An update that adds an intent asks again.
- Full freedom is still there behind intents: `ui.canvas` for free drawing, `viewport.overlay` for gizmos and previews.
  Plain panels use typed widgets that the host draws in the Funda look.

**Audit trail**, per plugin in Settings: every sensitive call (files, network, clipboard, document writes), every grant
change and every version change. Geometry calls are counted, not logged one by one.

The 10 bundled plugins move to the new contract. Their Vue panels become widget trees or canvases.

## Releases

- Versions are `2.0.0-indev.N`. Semver sorts that below `2.0.0`, so dropping `-indev` later is clean.
- A rolling `develop` pre-release is rebuilt from every green push to `dev`, like OrcaSlicer's nightly.
- Versioned indev builds are cut by hand when something is worth naming.
- Each major is its own line, with its own branch and update feed.
- Dropped: the beta channel and the `legacy` Python branch.
- FundaCAD 1 (Tauri): one last update shows a notice pointing to FundaCAD 2, then the line goes quiet. Until FundaCAD 2
  replaces it, it gets bug fixes only.

## Docs

The bar is the TrenchDot docs (TrenchWorld/docs). The page style rules are already in breadcrumb 3h9tad9k. The gap is in
structure, not wording:

| | TrenchDot | FundaCAD manual |
|---|---|---|
| Pages | 84 | 79 |
| Screenshots | 284, about 3 per page | 65, under 1 per page |
| Tutorials that build a real thing | 7, one a 5 part series | 1 (first part) |
| "Coming from" pages | Unity or Blender, Hammer or TrenchBroom | none |
| Concept pages | "How entity I/O works" before the tools | none, pages are per tool |
| Extras | cheatsheet, tips, glossary, 7 languages | glossary |

For FundaCAD 2:

- A concept page that explains how history, parameters and direct edits fit together.
- "Coming from Fusion or Onshape", "Coming from FreeCAD" and "Coming from Blender".
- Tutorials that print a real part, end to end.
- Screenshots captured from the native app by script, as in TrenchDot.
- The manual ships inside the app and works offline.

## Order of work

0. **Spike** on D:/dev/neocad-wt worktrees, go or no-go before anything else:
   - a GPUI window with a wgpu viewport sharing the device, showing an engine mesh, orbiting at 60 fps on Windows and
     Linux
   - the same window running on OpenGL only (a Linux VM without Vulkan)
   - one Funda panel rebuilt beside the Vue one, compared side by side, backdrop blur included

   Result, 2026-11-26:

   | Spike | Verdict | Branch | Outcome |
   |---|---|---|---|
   | A, viewport | GO | spike/gpui-viewport | 165 fps (monitor cap) on Vulkan and GL, 4M triangles included, about 390 lines of GPUI fork |
   | B, look | CLOSE | spike/gpui-look | Preferences page within 2.3 of 255 mean pixel diff; GPUI has no backdrop blur |
   | C, OpenGL | GO | spike/gpui-gl | GPUI runs on GL alone, GL 3.3 needs a small patch, WGL needs a frame cap |

   Blur: panels over the 3D view blur it in our own viewport pass, dialogs over the chrome use the flat scrim. A real
   backdrop blur primitive in the fork is 1 to 2 weeks and can wait.
1. Shell, document, timeline and the parameter panel.
2. Sketching on the native solver, curves in 3D.
3. Feature tools and the inspector.
4. The plastic loop: drag to edit, merge, chip, intent after the fact.
5. Plugin host with intents and the audit trail, then the 10 bundled plugins.
6. Docs, the e2e harness on the new UI, `2.0.0-indev.1`, and the FundaCAD 1 notice.

## Open

- The exact v1 WIT surface.
- What replaces the 146 Playwright e2e files: GPUI's test harness, MCP driven checks or both.
- Which TS logic modules already have Rust twins (tests/vectors) and which must be ported.
