# FundaCAD over MCP

`mcp/` is a Model Context Protocol server that lets another model build, measure,
look at and describe FundaCAD parts. It speaks JSON-RPC 2.0 over stdio, which is
all MCP is on a stdio transport, and it is hand-rolled — no SDK is pinned into
this repository, and the whole protocol is one `handle()` in `mcp/server.py`.

`.mcp.json` at the repository root registers it, so a client that reads that file
(Claude Code among them) picks it up with no further setup:

```json
{ "mcpServers": { "fundacad": {
    "command": "uv",
    "args": ["run", "--project", "sidecar", "python", "mcp/server.py"] } } }
```

It runs on the sidecar's own virtual environment because everything it needs is
already a sidecar dependency: `websockets` for the link, `numpy` for the
renderer, `pillow` for the PNG.

## What it talks to

It drives the **sidecar**, the same geometry engine the app drives. That is the
whole point of the design: a gap an agent hits here is a gap a user hits in the
viewport, which is what makes driving the sidecar worth more than calling
build123d from this process.

There are two worlds it can be in.

**Live** — it joins the engine a running FundaCAD already has, and works on the
document that window has open. Edits appear on screen as they are made, each one
a single undo. This is the default when a window is open.

**Private** — it spawns its own sidecar on its own port with its own minted
token. It never competes with a running app for the serialised worker and never
touches what the user has open; an agent working this way works on its own copy
and hands the result back as a `.funda` file. This is what it does when no
window is open, and the only thing it did before live sessions existed.

### Choosing

`FUNDACAD_MCP_MODE` takes:

| value | what it does |
| --- | --- |
| `auto` (default) | live if a window is open, private if not |
| `attach` | live, or refuse to start. For a host meant to work on the open document and nothing else, where falling back quietly would look like the edits are being ignored |
| `standalone` | private, always, even with a window open |

An explicit `FUNDACAD_SIDECAR_TOKEN` in the environment beats all three: someone
who sets it is pointing this at a specific engine on purpose, and it is how the
probe scripts in this repository drive a session they can watch. (The retired
`SINDRI_` and `SINDRICAD_` spellings still answer, for a shell profile no rename
in here can reach.)

### How it finds a running window

A running app writes `session.json` into its app data directory naming its
engine's port and token, and removes it on the way out
(`src-tauri/src/session_file.rs`). `mcp/app_session.py` reads it and then does
the thing that actually settles the question: dials that port with that token and
pings. The file is a hint — it survives a crash — so a stale one costs one
connect and is then ignored.

The token being on disk is a real change and is documented where it is written.
It is written user-only, so anything that can read it can already read the user's
documents directly; what makes the reach into the OPEN document acceptable is
that it is visible and revocable, not that it is small.

### The window's half

Sharing is a setting in FundaCAD's Preferences, under **Assistants**:

- **Do not share** — nothing is published; an agent falls back to a private copy.
- **Share, read only** — an agent can read and measure, and its edits are refused
  by name rather than by timing out.
- **Share, and allow edits** (the default) — edits are applied through the
  document store, one undo step each.

While an assistant is attached, a badge next to the document name says who it is
and what it last did, and clicking it opens that setting.

The rules live in `sidecar/live_session.py`: one HOST (the window, which owns the
document and is the only thing that may raise its revision) and any number of
GUESTS (which may read and PROPOSE, never write). A proposal names the revision
it was written against and is refused if the document has moved on, so an agent
cannot overwrite what a person did while it was thinking.

On Windows the sidecar it spawns is put in a job object with
`KILL_ON_JOB_CLOSE`, so the sidecar and its OCCT worker die with this process
however this process dies. That is not housekeeping: an MCP host kills its
servers with `TerminateProcess`, which runs no cleanup, and the sidecar's own
die-with-parent covers Linux and macOS only — its docstring says Windows is
"covered by the Rust-side Job Object", which is true of the app and of nothing
else. Measured without it: 46 orphaned worker processes, after which a fresh
sidecar could no longer start one and every build failed with "the geometry
engine could not start on this computer".

## The tools

| tool | what it is for |
| --- | --- |
| `schema` | every feature type, its fields, an example and its traps. Read first. |
| `doc_new` / `doc_open` / `doc_save` / `doc_get` / `doc_set` | the document |
| `param_set` / `param_remove` | the parameter table (this is what makes it parametric) |
| `feature_add` / `feature_update` / `feature_remove` / `feature_move` | the timeline |
| `build` | rebuild, and say what came out and what failed |
| `inspect` | exact volume, area, bbox, and every face and edge with a ready-made selector |
| `view` | a PNG: orthographic, flat-shaded, with sections, body filtering and zoom |
| `export` | STEP, STL, 3MF, OBJ, BREP |

`schema` is also served as an MCP resource at `fundacad://schema`.

### Why `inspect` returns selectors

A feature addresses geometry that does not exist until the rebuild runs, through
a `Selector` — usually `by:"match"` carrying a geometric fingerprint. An agent
has never clicked on anything, so it cannot author one. `inspect` therefore
returns, for every face and every edge, the exact selector that addresses it,
authored by `geom_select`'s own fingerprint functions. Paste it into the next
feature.

It also flags the two shapes that make later features fail:

- **seam edges** (`"seam": true`) — the line where a face that wraps all the way
  round closes on itself. Both sides are the same face, so a fillet or chamfer on
  one is refused.
- **wrapping faces** (`"wraps": true`) — the same property seen from the face
  side. A linear press/pull has no direction for one of these; it is thickened
  along its own surface instead.

### Why `view` has sections

The thing an agent most often needs to see is inside. `view` takes:

- `section: {axis, at, keep}` — cuts the model open. There is no cap on the cut,
  so you see the inside surfaces, drawn darker than the outside. `keep` says
  which half survives: `below`/`min`/`near` or `above`/`max`/`far`. A word it does
  not know is refused, not guessed at.
- `bodies: [...]` — draw one part of an assembly.
- `focus: {at, size}` — a window that many millimetres across. A 1.5 mm thread on
  a 200 mm spool is four pixels of a fitted view.
- `highlight_faces: [...]` — paint named faces orange, to answer "which one is
  face 7".

The renderer is a z-buffered flat rasteriser in `mcp/render.py`: pure numpy,
arrays in and an array out, no browser and no GPU. It is deliberately plain. The
app's own renderer stays the authority for what a person sees; this answers "did
that do what I meant".

## Driving it without an MCP host

`mcp/client.py` is a small client. It is in the repository because the end-to-end
test needs one — testing the tools by calling their coroutines would skip the
protocol, and the protocol is where a stray `print` to stdout or a reply to a
notification breaks everything under a real host. It doubles as a command line:

```sh
uv run --project sidecar python mcp/client.py                     # list the tools
uv run --project sidecar python mcp/client.py schema '{"type":"revolve"}'
uv run --project sidecar python mcp/client.py --script build.json
```

Each invocation is a fresh server with an empty document, so a sequence of
one-shot calls is not a session — use `--script`, which is either a JSON array of
`{"tool": ..., "args": {...}}` or one such object per line. Images are written to
`view-<n>-<k>.png` in the working directory.

## Things that are true here and not in every CAD

- **Z is up.** A sketch on XY is a floor plan; a sketch on XZ is a side elevation.
- **`box`, `cylinder` and `sphere` are centred on the origin.** Use a `move`
  feature to place them.
- **Body ids are not feature ids.** `body1`, `body2`, … are assigned in creation
  order at build time; read them back from `build` or `inspect`. A Join
  *renumbers* the body it merges into, so re-read them after one.
- **A field takes a number or a parameter NAME, never an expression.** The app
  evaluates expressions in the parameter table and writes plain numbers into
  fields, so `"radius": "hub_d/2"` does not resolve — define a parameter for the
  expression and put its name in the field.
- **A join or a cut acts on EVERY visible body it overlaps**, not on the nearest
  one. That is what dragging a face across two touching parts means; it is not
  what building a second part beside a first one means. Set `targets` — a list of
  body ids — on any `extrude`, `revolve`, `loft`, `sweep`, `thicken`, `box`,
  `cylinder` or `sphere` whose operation is not `new`, as soon as more than one
  body exists. Found by an agent building a two-half spool: an oversized cut tool
  reached across and took material out of a body it had never named.
- **A feature can only reference features above it in the timeline.**

## Layout

| file | what it holds |
| --- | --- |
| `server.py` | the protocol and the tools |
| `sidecar_link.py` | spawning the sidecar and speaking to it |
| `model.py` | the document: ids, the timeline, the parameter table, validation |
| `expr.py` | the expression language, a port of `src/params/{parse,eval}.ts` |
| `render.py` | the rasteriser: camera, clipping, z-buffer, shading |
| `describe.py` | turning an `inspect` report into something worth reading |
| `schema.py` | the feature reference the agent reads |
| `client.py` | the client the tests and the command line use |
| `winjob.py` | the Windows job object that makes the engine die with the server |

`expr.py` and `schema.py` are both ports of things whose authority lives
elsewhere, so both are pinned by tests: `mcp/tests/test_expr.py` holds the
grammar (degrees trig, right-associative `^`, semicolon arguments) and
`mcp/tests/test_schema.py` holds every documented type against the sidecar's own
`_FEATURE_HANDLERS` table, in both directions.

Tests run the same way the sidecar's do, and CI globs both directories:

```sh
cd sidecar && uv run python ../mcp/tests/test_render.py
```
