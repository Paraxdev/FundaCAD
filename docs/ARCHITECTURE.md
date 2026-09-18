# Architecture

FundaCAD is one executable running as two processes: a Tauri (Rust) shell with a
TypeScript frontend in its webview, and the geometry engine, the same executable
started as `fundacad --engine`, a worker the shell supervises.

```
┌─ Tauri shell (Rust, src-tauri) ────────────────────────────────┐
│  • native window, file dialogs, the document container,         │
│    plugins and their local-network requests                     │
│  • supervises the engine worker: spawn, restart, cancel, relay  │
│    (src-tauri/src/engine.rs)                                    │
│                                                                 │
│  ┌─ Frontend (TypeScript, in the webview) ──────────────────┐   │
│  │  • Three.js viewport (orbit/pan/zoom, ViewCube, picking,  │   │
│  │    Z-up)                                                  │   │
│  │  • UI: browser tree, timeline, parameters, toolbar        │   │
│  │  • owns the DOCUMENT (feature tree + parameters)          │   │
│  └───────────────────┬────────────────────────────────────────┘   │
└──────────────────────┼────────────────────────────────────────────┘
                       │  Tauri IPC in the window, framed messages
                       │  on the worker's stdio (see PROTOCOL.md)
                       ▼
┌─ Geometry engine (Rust + OpenCASCADE 7.8.1, crates/) ──────────┐
│  • rebuild(document) -> mesh + per-triangle faceIds + edges     │
│  • export(document, format, path) -> STEP / STL / 3MF / GLB     │
│  • selector resolution (topological-naming mitigation)          │
│  • plugin geometry, as sandboxed WebAssembly components         │
└─────────────────────────────────────────────────────────────────┘
```

The same engine serves a loopback WebSocket as `fundacad-engine --ws` for a browser
in development and the e2e scripts, and the app's worker opens one beside its stdio
pipe for a live MCP session (docs/MCP.md).

Optional pieces live outside both, in two forms. A downloaded plugin
arrives in the per-user app data directory, declares what it wants to reach
before it is installed, and is held to that declaration when the bundle is
unpacked. A built-in capability ships inside
the app but is loaded only when it is turned on: the printer connection, the 3D
mouse and multi-material are each behind a dynamic import, and a test fails if
anything in the core reaches for one statically. `docs/PLUGINS.md` has the
permission model, what "off" is guaranteed to mean, and why the download happens
in Rust rather than the webview.

FundaCAD owns the document, the feature tree and the UI. OpenCASCADE owns the geometry
kernel itself; FundaCAD does not reimplement one.

## Hard invariants

These hold across the whole codebase. A change that would break one needs a plan and a
reason, not a quick patch.

1. **Geometry lives only in the engine** (`crates/fundacad-geom`), in its own process.
   The frontend and the shell never touch the kernel, so a kernel crash restarts the
   worker and never takes the window or the unsaved document with it.
2. **Stateless full rebuild.** The frontend's logical model is "send the document, get
   back a mesh", the engine replays the feature tree from scratch on every change.
   A failing feature is recorded as a no-op and the rebuild continues past it, rather
   than aborting the whole document. (The wire protocol layers a delta encoding and a
   per-body cache on top of this for performance; see PROTOCOL.md, the semantics stay
   stateless from the frontend's point of view.)
3. **Selectors, not topology indices.** Geometry the frontend references (an edge for a
   fillet, a face for a pattern) is picked by a queryable descriptor, an axis, a face
   normal, the nearest point, never by a raw topology index. Indices renumber when
   upstream geometry changes; descriptors are re-resolved against the rebuilt shape, so
   a downstream feature keeps landing on the right edge.
4. **The window reaches the engine over IPC and nothing else.** The webview's
   Content-Security-Policy `connect-src` is `'self' ipc: http://ipc.localhost` and
   must never be widened to admit an arbitrary URL. One app instance only:
   `tauri-plugin-single-instance` (registered first, in `lib.rs`) makes a second
   launch focus the running window, since two would share one plugin directory, one
   blob store and one session file. That is why the updater restarts through
   `restart_for_update` rather than the process plugin's `relaunch()`: the instance
   lock has to be dropped before the replacement process starts, or the new instance
   quits on launch. The engine worker opens a loopback port with a per-launch token
   for a live session, and the app writes that port and token into `session.json` in
   its app data directory (`session_file.rs`), removing it on exit, so an outside
   program can join the session instead of starting a second engine, see
   `docs/MCP.md`. That file is the one place the token reaches disk; it is written
   user-only, and reaching the open DOCUMENT through it is gated separately by a
   setting in the app.
5. **Display-only state stays in frontend side-maps.** Visibility, display names,
   palette/body colors, MATERIALS, and the ELEMENTS a body is filed into are UI state, not
   model state, they live in `DocumentStore` side-maps, not in the `document` sent
   to the engine, and are threaded explicitly through the calls that need them
   (e.g. `exportWith`). Elements (`src/document/elements.ts`) are the strongest
   case for the rule: they exist so a several-thousand-body import can be sorted
   into something navigable, and organising a model must never be able to change
   its geometry. A document with every element deleted rebuilds byte-identically
   to one that never had any. Materials (`src/document/materials.ts`) are the
   same bargain in the other direction: they are appearance only, a colour and a
   finish, never a physical property, and they are deliberately NOT the filament
   `palette`, which means "make this part from filament N". Where a body carries both, the palette slot wins on
   screen; the render bridge is the one place that decides.
6. **Pattern expansion and region detection are mirrored TS <-> Rust.** Both sides
   independently expand associative patterns and detect split regions for direct
   editing; a change to one algorithm without the matching change to the other silently
   diverges preview from build. Shared vectors under `tests/vectors/` hold the pairs
   together where they exist.
7. **`src/input/shortcuts.ts` is the single source of truth for keyboard shortcuts.**
   The keymap dispatcher, the command palette, and the `?` shortcut HUD all read from
   this one table so they can't disagree about what a key does.

## Frontend structure, state and lifetimes

The frontend passes its core objects down by parameter. There is no service
locator and no container.

- **The composition root** is `src/app/engine.ts`. It builds the `Viewport`, the
  `DocumentStore`, the `SketchOverlay`, `SketchMode` and every tool once, and holds
  them on one `Engine` record.
- **Tools and modes take what they use in their constructor**, for example
  `new MoveTool(viewport, store)` or `new SectionTool(viewport, { toolBusy })`. A
  dependency that would be circular is passed as a late-bound function
  (`toolBusy: () => e.toolBusy()`) rather than as the object.
- **Behaviour spread over the engine** is a factory that takes the engine and
  returns functions: `createToolBusy(e)`, `createFeatureStarters({...})`,
  `installViewportWiring(e)`.
- **Vue components** get the engine through `useEngine()` and talk to each other
  through Pinia stores, which carry primitives and ids, never engine objects.

Where state may live:

| Kind of state | Where | Examples |
|---|---|---|
| The document and anything saved with it | `DocumentStore` | features, overlays, materials, versions |
| One viewport's view of the model | `Viewport` | selection, section view, emitter lights |
| A user preference | a settings module read with `storedSetting` and a change listener | `renderPrefs`, `units`, `theme` |
| A cache keyed by what it describes | module level, bounded with `LruCache` | material previews, glyph outlines |
| UI state shared between components | a Pinia store | `shell`, `selection`, `timeline` |

A module-level `let` is acceptable only for the last three. Anything tied to a
document or a viewport belongs to the object with that lifetime, so that
replacing the document or closing a sketch can release it.

Cleanup has one owner per lifetime. A session that attaches listeners, frames or
three.js objects registers each with a `Disposer` (`src/lib/disposer.ts`) as it
creates it, and releases them all with one `dispose()` when it ends; an open
sketch is the model (`SketchMode.session`). Geometry that leaves the scene goes
through `disposeObject3D`, which walks the whole subtree, because a text is a
group of lines and a direct-children loop leaves them on the GPU.
`e2e/memory_e2e.cjs` replaces a document over and over and fails when the
renderer's geometry or texture count, or the heap, does not come back.

## The rebuild pipeline

1. The frontend sends the document (or, once a baseline is established, just the
   changed features) to the engine.
2. The engine replays the feature tree from scratch, sketch, extrude, fillet,
   pattern, and so on, in timeline order, inside its long-lived worker process.
3. If a feature fails (a fillet with no matching edge, a boolean that would be a
   no-op), that failure is recorded and the feature is treated as a no-op. The rebuild
   **continues** with the remaining features rather than discarding the whole document.
4. The result is tessellated per body and sent back as a mesh (positions, indices,
   per-triangle face ids) plus edge polylines, with any feature errors attached so the
   frontend can show a banner without losing the geometry that did build.
5. The frontend never accumulates its own geometry state across edits, the same
   `document` always rebuilds to the same result, deterministically.

See [PROTOCOL.md](PROTOCOL.md) for the exact wire shapes, including the delta-send and
per-body etag mechanisms that make this fast without changing the statelessness above.

## What ships

One executable, `fundacad`, with OpenCASCADE 7.8.1 compiled into it statically, and
`fundacad-mcp` beside it. No runtime, interpreter or system OpenCASCADE is needed on
the machine the app runs on. See [PACKAGING.md](PACKAGING.md) for the build.
