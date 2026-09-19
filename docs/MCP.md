# FundaCAD over MCP

MCP is part of FundaCAD. It is how an AI assistant drives the app: build,
measure, look at and describe a part, on the document open in the window or on
a copy of its own. It is not a plugin and there is nothing to install.

The server is `fundacad-mcp` (`crates/fundacad-mcp`), a Model Context Protocol
server on the official Rust SDK (`rmcp`, stdio transport, `#[tool]`). Release
builds link it into `fundacad`; start the same application executable with
`--mcp`, in an installer or as the portable Windows download.

## Connecting an assistant

**Preferences, AI assistants (MCP)** is the whole of it:

- **Live document** decides what an assistant may do with the document that is
  open (see [The window's half](#the-windows-half)).
- **Status** says whether the document is shared and which assistant, if any, is
  connected right now, and whether it can edit.
- **How to connect it** gives the setup for the bundled server in the shape each
  host takes, with a Copy button:

| assistant | what to do with it |
| --- | --- |
| Claude Code | run `claude mcp add --scope user fundacad -- "<install dir>/fundacad.exe" --mcp` in a terminal |
| Claude Desktop | add the block below to `claude_desktop_config.json` (Settings, Developer, Edit Config) and restart it |
| another MCP host | start `<install dir>/fundacad.exe --mcp` over stdio; hosts that read an `mcpServers` block take the same one |

```json
{ "mcpServers": { "fundacad": {
    "command": "<install dir>/fundacad.exe",
    "args": ["--mcp"],
    "env": {} } } }
```

The path is the real one on that machine: the app asks for its executable with
the Tauri command `mcp_server` (`src-tauri/src/engine.rs`). The setup is built in
`src/live/mcpConnect.ts` and shown by `src/components/overlays/McpSection.vue`.

It needs no path to anything else. A private session starts the app beside it
as its engine, `fundacad --engine --ws`, rather than a second shipped
`fundacad-engine`: the kernel is linked statically, so a second binary would be
a second copy of it, twice the download for the same code, and one that could
drift from the version the window runs. A live session attaches to the running
window: its worker serves a loopback WebSocket beside its stdio pipe, sharing
the one engine and so the one live session, and the app writes that port and a
per launch token to `session.json`.

### An install that had the old MCP plugin

Before 1.0 the MCP server was the `FundaCAD.MCP` plugin: the server
downloaded into `<app data>/plugins/FundaCAD.MCP`, plus a companion that added
an Assistants block to Preferences. The app removes that directory the first
time it lists its plugins (`RETIRED_PLUGINS` in `src/plugins/index.ts`), says
so in a toast, and never starts the companion. It is removed rather than hidden
because it can no longer do anything useful: the server in it runs on the
sidecar this build does not have, and its settings block would be a
second copy of the core section. An assistant configured with the old
`server.py` path needs the new setup from the section above.

## From a checkout

`.mcp.json` at the repository root registers the same server for this
repository's own sessions, so a client that reads that file (Claude Code among
them) picks it up with no further setup:

```json
{ "mcpServers": { "fundacad": {
    "command": "node",
    "args": ["scripts/mcp-rust.mjs"] } } }
```

Build it once, then reconnect:

```sh
cargo build --release -p fundacad-mcp -p fundacad-cli
```

`scripts/mcp-rust.mjs` runs the newest `fundacad-mcp` under `target/release` or
`target/debug` (or `CARGO_TARGET_DIR`), and with none it exits at once saying
the command above. It used to be `cargo run`, and a first compile outlasts an
MCP host's 30 s connect timeout, which the host reports as a bare timeout.
`fundacad-cli` is the `fundacad-engine` a private session starts from a
checkout, and needs OpenCASCADE (`FUNDACAD_OCCT_ROOT`); attaching to a running
app needs only `fundacad-mcp`.

## What it talks to

It drives the **engine**, the same one the app drives. That is the whole point
of the design: a gap an agent hits here is a gap a user hits in the viewport.

It does not link the geometry kernel itself. A private session spawns an engine
with `--ws` and talks to it over the same loopback socket a live session uses,
so the two worlds are one code path and an OpenCASCADE abort takes the engine
rather than the conversation. The binary to spawn is named by
`FUNDACAD_ENGINE_CMD`, or found next to this one: `fundacad-engine`, then the
app itself (`fundacad --engine --ws`, recognised by the `engine_attach` command in
its bytes, so a beta window running the sidecar is never started by mistake), then the
workspace `target/` directories. The spawned engine is told the app's plugin
directory unless `FUNDACAD_PLUGIN_DIR` is already set.

Tool calls are answered in the order they arrive: the SDK spawns a task per
request, so the server runs on a single-threaded runtime and holds one turn
lock.

There are two worlds it can be in.

**Live**, it joins the engine a running FundaCAD already has, and works on the
document that window has open. Edits appear on screen as they are made, each one
a single undo. This is the default when a window is open.

**Private**, it spawns its own engine on its own port with its own minted
token. It never competes with a running app and never touches what the user has
open; an agent working this way works on its own copy and hands the result back
as a `.funda` file. This is what it does when no window is open.

### Choosing

`FUNDACAD_MCP_MODE` takes:

| value | what it does |
| --- | --- |
| `auto` (default) | live if a window is open, private if not |
| `attach` | live, or refuse to start. For a host meant to work on the open document and nothing else, where falling back quietly would look like the edits are being ignored |
| `standalone` | private, always, even with a window open |

An explicit `FUNDACAD_ENGINE_TOKEN` (with `FUNDACAD_ENGINE_PORT`) in the
environment beats all three: someone who sets it is pointing this at a specific
engine on purpose, and it is how the probe scripts in this repository drive a
session they can watch. (The retired `FUNDACAD_SIDECAR_` names and the `SINDRI_`
and `SINDRICAD_` spellings still answer, for a shell profile no rename in here
can reach.)

### How it finds a running window

A running app writes `session.json` into its app data directory naming its
engine's port and token, and removes it on the way out
(`src-tauri/src/session_file.rs`). `crates/fundacad-mcp/src/app_session.rs`
reads it and then does the thing that actually settles the question: dials that
port with that token and pings. The file is a hint, it survives a crash, so a
stale one costs one connect and is then ignored. An assistant that started
before the app did asks again while the answer can still change, and switches
to the open document once one appears.

The token being on disk is a real change and is documented where it is written.
It is written user-only, so anything that can read it can already read the user's
documents directly; what makes the reach into the OPEN document acceptable is
that it is visible and revocable, not that it is small.

### The window's half

Sharing is the **Live document** setting in Preferences, AI assistants (MCP):

- **Do not share**, nothing is published; an agent falls back to a private copy.
- **Share, read only**, an agent can read and measure, and its edits are refused
  by name rather than by timing out.
- **Share, and allow edits** (the default), edits are applied through the
  document store, one undo step each.

While an assistant is attached, a badge next to the document name says who it is
and what it last did, and clicking it opens Preferences.

The rules live in the engine (`crates/fundacad-engine/src/live.rs`): one HOST
(the window, which owns the document and is the only thing that may raise its
revision) and any number of GUESTS (which may read and PROPOSE, never write). A
proposal names the revision it was written against and is refused if the
document has moved on, so an agent cannot overwrite what a person did while it
was thinking. The window's side is `src/live/liveSession.ts`.

On Windows the engine a private session spawns is put in a job object with
`KILL_ON_JOB_CLOSE`, so it dies with this process however this process dies.
That is not housekeeping: an MCP host kills its servers with `TerminateProcess`,
which runs no cleanup. Measured without it: 46 orphaned worker processes, after
which a fresh engine could no longer start one and every build failed.

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
| `doc_import` | read a STEP, STL, 3MF, OBJ, BREP or GLB file in as a body to model against, by `path` or as inline `content`, compressed and in pieces if it is large |
| `export` | STEP, STL, 3MF, OBJ, BREP |

`schema` is also served as an MCP resource at `fundacad://schema`.

The same names are the op vocabulary a compute plugin reaches the document
through (`src/plugins/broker/ops.ts`), and `tests/plugins/broker.test.ts` reads
the tool list out of `crates/fundacad-mcp/src/server.rs` so the two cannot
drift.

### Getting a file in when there is no path to it

`doc_import` takes a `path`, which assumes the file is on the machine FundaCAD
runs on. Often it is not: a host that hands its model an upload gives it the
bytes and nothing else. So the file can be sent inline instead, as `content`.

Three things make that practical for a real part rather than a toy one.

**Encoding.** base64 by default, or `encoding: "text"` for a format that is
already text (STEP, OBJ, ASCII STL), because re-encoding one is a step whose
only purpose is to be undone on this side.

**Compression.** `compression: "gzip"` or `"zip"`, or a name ending `.gz`,
`.zip` or `.stpz`. A STEP file is text and gzips about tenfold, so this is the
single biggest lever on whether a part fits in a message at all. gzip is also
recognised from its first two bytes, since nothing we read begins `1f 8b`. A
zip is never assumed, only ever declared: a 3MF **is** a zip archive and the
engine reads it as one, so unpacking anything that merely looked like a zip
would turn a 3MF import into whatever happened to sit inside it.

**Pieces.** `part` and `parts`, quoting the `upload` id the first reply returns.
The ceiling on one message is the model's output, not this process's memory, so
the pieces are what lift it. Encode the whole file once and split the text that
comes out; encoding each piece separately produces something that does not join
back up, and a piece ending in base64 padding is refused for saying so.

Nothing is imported until the last piece arrives, so a half-sent file never
reaches the document, and in a live session it never reaches the app: the
document is unchanged, and nothing is offered when a tool changed nothing. The
pieces are spooled to a temporary directory rather than joined in memory, and
that directory is removed as soon as the read returns, or after 30 minutes if
nobody comes back for it.

What arrives inline is capped at 64 MiB across all the pieces, and what comes
out of an archive at 512 MiB, above the engine's own 400 MiB limit for a STEP so
that nothing is refused here that the reader would have taken. The ratio between
an archive and its contents has no upper bound, so a limit only on what arrives
would be no limit at all. `path` has no ceiling and stays the answer for
anything genuinely large.

### The limit that actually binds

None of those numbers is the one that decides anything. Inline content is
written by the model, character by character, as its own output. A megabyte of
base64 is somewhere north of a quarter of a million tokens, so the ceiling is
the model's output budget: roughly one message per piece, and a few hundred
kilobytes in each at the very most. Compression is what makes that a real
option, and it is a tenfold difference on a STEP, not a marginal one. Beyond a
handful of pieces it stops being worth doing at all.

That matters more than it sounds, because of what an agent does when it decides
a file cannot be sent. It does not stop. It measures the part with whatever it
has and models against a simplified stand-in, and the result is wrong in the one
way nothing downstream catches: every measurement it takes afterwards is
consistent with every other one. So the tool says the alternative out loud
wherever the question comes up (a missing path, an oversized payload, the first
piece of a long upload): ask the person for the path on the machine FundaCAD
runs on, or ask them to open the file themselves with **File, Import Mesh**,
after which it is in the document and `inspect` measures the real geometry. In
a live session that is the cheapest route by a wide margin, and no bytes cross
the wire at all.

### Why `inspect` returns selectors

A feature addresses geometry that does not exist until the rebuild runs, through
a `Selector`, usually `by:"match"` carrying a geometric fingerprint. An agent
has never clicked on anything, so it cannot author one. `inspect` therefore
returns, for every face and every edge, the exact selector that addresses it,
authored by the engine's own fingerprint functions. Paste it into the next
feature.

It also flags the two shapes that make later features fail:

- **seam edges** (`"seam": true`), the line where a face that wraps all the way
  round closes on itself. Both sides are the same face, so a fillet or chamfer on
  one is refused.
- **wrapping faces** (`"wraps": true`), the same property seen from the face
  side. A linear press/pull has no direction for one of these; it is thickened
  along its own surface instead.

### Why `view` has sections

The thing an agent most often needs to see is inside. `view` takes:

- `section: {axis, at, keep}`, cuts the model open. There is no cap on the cut,
  so you see the inside surfaces, drawn darker than the outside. `keep` says
  which half survives: `below`/`min`/`near` or `above`/`max`/`far`. A word it does
  not know is refused, not guessed at.
- `bodies: [...]`, draw one part of an assembly.
- `focus: {at, size}`, a window that many millimetres across. A 1.5 mm thread on
  a 200 mm spool is four pixels of a fitted view.
- `highlight_faces: [...]`, paint named faces orange, to answer "which one is
  face 7".

The renderer is a z-buffered flat rasteriser (`crates/fundacad-mcp/src/render.rs`,
the PNG from `png.rs`): arrays in and an image out, no browser and no GPU. It is
deliberately plain. The app's own renderer stays the authority for what a person
sees; this answers "did that do what I meant".

## Driving it without an MCP host

`crates/fundacad-mcp/tools/client.py` is a small generic MCP client. It speaks
the protocol over a real pipe, which is where a stray print to stdout or a reply
to a notification breaks everything under a real host, and it doubles as a
command line. It drives the built `fundacad-mcp` (`FUNDACAD_MCP_BIN`, or the
newest under `target/`) unless `--server` names another:

```sh
python crates/fundacad-mcp/tools/client.py                     # list the tools
python crates/fundacad-mcp/tools/client.py schema '{"type":"revolve"}'
python crates/fundacad-mcp/tools/client.py --script build.json
```

Each invocation is a fresh server with an empty document, so a sequence of
one-shot calls is not a session, use `--script`, which is either a JSON array of
`{"tool": ..., "args": {...}}` or one such object per line. Images are written to
`view-<n>-<k>.png` in the working directory.

## Things that are true here and not in every CAD

- **Z is up.** A sketch on XY is a floor plan; a sketch on XZ is a side elevation.
- **`box`, `cylinder` and `sphere` are centred on the origin.** Use a `move`
  feature to place them.
- **Body ids are not feature ids.** `body1`, `body2`, … are handed out at build
  time; read them back from `build` or `inspect`. The document remembers them
  (`bodyIds`), so a body keeps its id when features around it are added,
  removed or switched off, and a Join keeps the id of the body it merges into.
- **A field takes a number or a parameter NAME, never an expression.** The app
  evaluates expressions in the parameter table and writes plain numbers into
  fields, so `"radius": "hub_d/2"` does not resolve, define a parameter for the
  expression and put its name in the field.
- **A join or a cut acts on EVERY visible body it overlaps**, not on the nearest
  one. That is what dragging a face across two touching parts means; it is not
  what building a second part beside a first one means. Set `targets`, a list of
  body ids, on any `extrude`, `revolve`, `loft`, `sweep`, `thicken`, `box`,
  `cylinder` or `sphere` whose operation is not `new`, as soon as more than one
  body exists. Found by an agent building a two-half spool: an oversized cut tool
  reached across and took material out of a body it had never named.
- **A feature can only reference features above it in the timeline.**

## Layout

| file | what it holds |
| --- | --- |
| `src/server.rs` | the protocol and the tools |
| `src/tools.rs` | the tools' input schemas and descriptions |
| `src/upload.rs` | inline `doc_import` content: decoding, pieces, archives |
| `src/link.rs` | finding and spawning the engine, its lifetime, the Windows job object |
| `src/app_session.rs`, `src/live.rs` | finding a running window and the live session |
| `src/model.rs` | the document: ids, the timeline, the parameter table, validation |
| `src/render.rs`, `src/png.rs` | the rasteriser and its PNG |
| `src/describe.rs` | turning an `inspect` report into something worth reading |
| `src/docfile.rs` | reading and writing `.funda` and `.fundab` |
| `src/schema.rs`, `src/schema.json` | the feature reference the agent reads |
| `tests/` | one suite per module, driving the built binaries over real stdio and a real socket |
| `tools/client.py` | the generic client above |

Expressions are `fundacad-core::params`, the Rust twin of
`src/params/{parse,eval}.ts`, so there is no copy of the grammar here to keep in
step.

The suites need the workspace binaries built first, `fundacad-engine` among
them, or the engine discovery and live session tests have nothing to start:

```sh
cargo build --workspace --features fundacad-engine/ws
cargo test --workspace --features fundacad-engine/ws
```

## The earlier plugin server it replaced

The server began as the `FundaCAD.MCP` plugin described above, and
`crates/fundacad-mcp` is its port: the tool list the two published was
byte-identical and a scripted session answered the same, which was asserted
rather than hoped for. The plugin server and its eleven suites were deleted with
the sidecar; every suite has a twin under `crates/fundacad-mcp/tests/`, and
`tests/parity_golden.rs` replays `tools/parity.jsonl` against the Rust server and
wants the earlier server's recorded transcript
(`tests/golden/mcp_parity.golden.json`) word for word.
