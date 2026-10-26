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

### Which files the server can reach

`doc_open`, `doc_save`, `doc_import`, `export`, and the `record` of `ui_open`
and the `open_file`, `import_file` and `save_as` steps of `ui_do`, check their
path first (`crates/fundacad-mcp/src/scope.rs`). The path is made absolute
(a relative one against the working folder), `..` folded and every part that
exists resolved through links, so neither `..` nor a link leads around a rule.

By default, started with no folders as the Preferences Copy text does, any
path is reached except:

- a file directly in home itself, in a drive or filesystem root, or in a
  folder that holds home (`C:\Users`, `/home`); their subfolders are fine;
- anything with a hidden name (a leading dot) in its path, so `.git`, `.ssh`
  and `.config` stay out of reach;
- UNC paths, `\\.\` and `\\?\` device and verbatim paths, `C:name`, a colon
  in a name (an NTFS alternate data stream) and device names such as `NUL` or
  `COM1`, refused on every platform.

The app's own folders (the system temp folder, `<app data>/recovery` and the
blob dir, `FUNDACAD_BLOB_DIR`) are reached in full, as tempfile names its
folders `.tmpXXXX`.

Strict mode keeps the server to a folder list. It is on when a folder is
given with `--allow-path <folder>` (repeatable, after `--mcp` for
`fundacad`, which checks that `--mcp` is its first argument), listed in
`FUNDACAD_MCP_ALLOW_PATHS` (separated the way `PATH` is), or when
`FUNDACAD_MCP_STRICT=1`. Then a path is reached only inside:

- the open document's folder: the file opened or saved here, or in a live
  session the file the window has open;
- the app's own folders;
- every given folder.

Home and drive roots themselves are never a given folder, nor a folder that
holds home, so `--allow-path ~` is ignored; the log and every refusal say so,
and the server still keeps to its list. Hidden names below the document's
folder or a given one are refused unless such a folder is given itself. A
strict refusal names the folder that would let it through and how to give it.

The check is made when the tool is called, so a folder swapped for a link
after that, or a hard link, is not caught. In the default mode a write goes
wherever the person's account can write, as it did before the check, so the
host's approval of `doc_save` and `export` (`destructiveHint`) is the guard.

```json
{ "mcpServers": { "fundacad": {
    "command": "<install dir>/fundacad.exe",
    "args": ["--mcp", "--allow-path", "D:/parts"],
    "env": {} } } }
```

Each tool also carries MCP's `readOnlyHint`, `destructiveHint`,
`idempotentHint` and `openWorldHint`, so a host can run `inspect`, `measure`,
`view` and the other checks without asking and ask before `doc_save` or
`export` writes a file. None opens the network. `tests/tool_hints.rs` holds the
table, and a new tool fails it until it is classified.

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
its bytes, so a legacy window running the sidecar is never started by mistake), then the
workspace `target/` directories. The spawned engine is told the app's plugin
directory unless `FUNDACAD_PLUGIN_DIR` is already set.

On Windows the process the host starts runs the server from a copy of its own
executable in `%TEMP%\fundacad-mcp-shadow`, and copies the engine it found
beside it there too, because Windows will not overwrite an executable that is
running: with a host holding `fundacad.exe --mcp` open, `cargo build` failed
with "Access is denied". The build now writes the original freely and the next
server the host starts runs it. `FUNDACAD_MCP_SHADOW=0` runs in place,
`FUNDACAD_MCP_SHADOW=1` copies on other platforms too
(`crates/fundacad-mcp/src/shadow.rs`).

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

A document can build differently on two builds of the engine, so each engine
names the commit it was built from in its `ping` reply (docs/PROTOCOL.md). When
the server works on an engine it started while it knows FundaCAD's engine is a
different build, after the window it was attached to closed or when a window
that opened after it started is not sharing, the note that the work went to a
private copy and every `build` reply say so, naming both commits. In
`standalone` it never looks for a window, so it has nothing to compare with.

### Choosing

`FUNDACAD_MCP_MODE` takes:

| value | what it does |
| --- | --- |
| `auto` (default) | live if a window is open, private if not |
| `attach` | live, or refuse to start. For a host meant to work on the open document and nothing else, where falling back quietly would look like the edits are being ignored |
| `standalone` | private, always, even with a window open |

An explicit `FUNDACAD_ENGINE_TOKEN` (with `FUNDACAD_ENGINE_PORT`) in the
environment is preferred over all three: someone who sets it is pointing this at a specific
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
was thinking. A proposal also names the document session it read (`doc`):
when the window opens, creates or discards a document before taking the edit,
the engine drops it and the tool fails with "the document in the app changed,
nothing was applied", so an edit never lands in the next document. `doc_new`,
`doc_open` and `doc_set` propose a whole other document (`replaces`), which the
window refuses while an import is still being read into its open document, since
the import would land in the one the agent put there; the tool fails with the
window's reason (it lists refusals by proposal id in its status) rather than
timing out. An ordinary edit is taken as usual. The window's side is
`src/live/liveSession.ts`.

On Windows the engine a private session spawns is put in a job object with
`KILL_ON_JOB_CLOSE`, so it dies with this process however this process dies.
That is not housekeeping: an MCP host kills its servers with `TerminateProcess`,
which runs no cleanup. Measured without it: 46 orphaned worker processes, after
which a fresh engine could no longer start one and every build failed.

## The tools

| tool | what it is for |
| --- | --- |
| `schema` | every feature type, its fields, an example and its traps. Read first. |
| `doc_new` / `doc_open` / `doc_save` / `doc_get` / `doc_set` | the document. `doc_open` of a file from a newer FundaCAD adds a `note:` line naming the feature types this build does not know; they are kept and saved with the file. An older file holding an old feature type gets a note to open and save it in the app first, since MCP does not update old files. `doc_get` gives the geometry only (features, parameters, paramDefs, bodyIds, version), so `doc_set` replaces those and keeps the open document's other parts (stress study, environment, palette, materials, elements, reference images, body and face overlays) unless the document sent names them; a key sent as null clears it. `doc_new` and `doc_open` still replace everything |
| `param_set` / `param_remove` | the parameter table (this is what makes it parametric) |
| `feature_add` / `feature_update` / `feature_remove` / `feature_move` | the timeline |
| `edit` | several of the above and `param_set` in one call, all or nothing, optionally building once at the end |
| `sketch_merge` | replace overlapping closed shapes of a sketch with the lines, arcs and circles around their union, so an extrude picks it with one `regions` point; replies with that point |
| `build` | rebuild, and say what came out and what failed. After the first build it lists only the bodies that changed; `full` lists them all. A feature of a type this build does not know (a file from a newer FundaCAD) reads `SKIPPED (id): unknown feature type: X, kept in the document but not built`, and like a failure it sets isError |
| `interference` | which bodies overlap and by how much, and which come closer than a clearance, once or at every step of a parameter (`sweep`). A body that is not a closed solid is named as not checked, with why. Changes nothing |
| `section` | cut the bodies with a plane: the outline as closed loops of points, and area, centroid, second moments, section modulus and polar moment for beam checks |
| `stress` | a linear static stress analysis of one body: hold faces (`fixed`, or `supports` that are fixed, pinned or slider), load others with a force or a pressure, add its weight with `gravity`, pick a material, and get the peak von Mises stress and where, the largest deflection, the safety factor against yield, the load balance with the reaction at each support, warnings, and a PNG coloured by stress. Changes nothing |
| `printability` | what would go wrong printing the parts on an FDM printer: overhangs past 45 deg, walls under two nozzle widths, floors under two layers, gaps that would fuse, long bridges and open shells, each with its face and a `view` focus. As modelled or laid flat as `export` would. Changes nothing |
| `inspect` | exact volume, area, bbox, and every face and edge with a ready-made selector |
| `measure` | exact measurements on the B-rep. One thing (`a`): a face's surface, area, outward normal, radius and axis; an edge's length, direction, circle and arc; a body's volume, area and size. Two (`a`, `b`): the minimum distance with both closest points, the gap between parallel planar faces (a wall), centre to centre or axis to axis distance (a hole pitch), and the angle between planes, straight edges and axes. A thing is a face or edge selector from `inspect` with its `body`, `{body, face: n}` or `{body, edge: n}` (inspect's F and E numbers, for the current build only), a body id or name, or `{point: [x, y, z]}`; `want` narrows it to `distance`, `angle` or `centres`. Text in mm and degrees to 3 places, then a `raw:` line with the unrounded reply. Changes nothing |
| `view` | a PNG: orthographic, flat-shaded, with sections, body filtering and zoom |
| `doc_import` | read a STEP, STL, 3MF, OBJ, BREP or GLB file in as a body to model against, by `path` or as inline `content`, compressed and in pieces if it is large |
| `export` | STEP, STL, 3MF, OBJ, BREP. `separate` writes a file per body named after it, `body` one body, `layFlat` turns each part onto a flat face for printing |
| `guide_highlight` / `guide_wait` / `guide_clear` | guide mode, below: show the user a step in their own window and wait for them |

`schema` is also served as an MCP resource at `fundacad://schema`.

### Guide mode

`guide_highlight` puts a pulsing ring and a caption with Next and Stop in the
user's open window, on a control (`ui`, the refs the harness uses: `pick:fillet`,
`family:cat:MODIFY`, `field:radius`, `#timeline`, `menu:File/Open...`), a model area
(`model`, harness selectors such as `body1:top` or `between top front`, not
`inspect`'s fingerprints) or a part of the view (`region`, fractions of it). A
control folded away is ringed through what opens it, and the reply says so, as it
names near misses for a ref that is not on screen. `guide_wait` then waits until
the user presses Next, starts a tool, adds a feature, selects something or types a
value, and says which in one line; it holds the conversation's tool calls for up
to `timeout_s` (60 s by default, 120 at most). `guide_clear` ends the guide. When
the user presses Stop, the window clears everything and the next guide call says
`the user stopped the guide at step n of m, everything is cleared`, once.

It rides the live session (`session_guide`, [PROTOCOL.md](PROTOCOL.md)), so it
works with the window set to Share, read only as well as Share, and allow edits,
and never changes the document. It refuses by name rather than showing nothing:
in `standalone` (which never attaches to a window), when no window shares its
document, with an engine older than guide mode, and with a window that does not
take the step within 3 s. The user's side is in the manual,
`manual/docs/ai/guide.md`.

### Supports and gravity in `stress`

`fixed` holds faces still in every direction. `supports` adds more ways to
hold the part, each `{type, faces}`:

- `fixed` (the default when `type` is left out): held still, like `fixed`.
- `pinned`: round faces only, a hole or a pin. Held towards the face's
  cylinder axis and along it, free to turn about it. A flat face is refused.
- `slider`: held along the face's normal only, free to slide in the face
  without friction. A round face takes its exact normal from the model, so a
  slider in a hole or round a shaft leaves the part free to slide along the
  axis and turn about it, and one on a ball leaves it free to turn every way.
  One slider on several faces holds a node where they meet along each face's
  normal.

Give `fixed`, `supports` or both. Together they must stop every slide and
turn: a part on sliders alone, or on one pin alone, is refused with the motion
left free in words, for example `the body can still turn about the pin's axis
through (0, 0, 0), add another support` or `the body can still turn about the
hole's axis through (0, 0, 0), a slider leaves a hole free to turn, add another
support`. A refusal about a support or a load names it the way the app's panel
does and then by its place in your request, `support 1 (supports[0])`.

A load, or a fixed support, on a place that has no face of its own takes
`spots` in place of `faces`, each `{at: [x, y, z], radius}`: the body's surface
within `radius` mm of the point `at`, as far as it stays connected to the
point, so a spot on one side of a thin wall does not reach the other side. A
force is spread over the spot by area like over a face, and a pressure pushes
into it. A load in the crook of a hook is
`{"spots": [{"at": [12, 0, 3.5], "radius": 4}], "force": [0, 0, -50]}`, with no
face split for it first. A spot smaller than the elements is taken as about
one of them, with a warning, and one that is nowhere near the body is refused.

`gravity: true` pulls with 9.81 m/s2 along -Z, or give `[gx, gy, gz]` in m/s2.
It needs the material's density in g/cm3: the presets carry one (PLA 1.24,
PETG 1.27, ABS 1.04, ASA 1.07, PA12 nylon 1.01, PC 1.20, aluminium 6061-T6
2.70, steel S235 7.85) and a material of your own takes `density`. With gravity
on, `loads` may be left out. `[0, 0, 0]` pulls nowhere and counts as no gravity.

The summary adds a `weight` line when gravity is on, and the reaction at each
support, in the order `fixed` then `supports`, when there is more than one.

`refine` chooses how the mesh is refined: `standard` (the default) solves,
splits the elements where the stress error is high and solves again; `fine`
refines up to three times and takes longer; `off` solves one even mesh. The
mesh line of the summary says how many passes ran and the finest element size.

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

## Driving the app (standalone only)

With `FUNDACAD_MCP_MODE=standalone` the server offers five more tools that use a
private copy of the app the way a person does, in a browser against its own
engine, through the agent harness (`tools/harness`, [HARNESS.md](HARNESS.md)).
They are never offered in `auto` or `attach`, so they can never touch the
window someone is working in.

| tool | what it is for |
| --- | --- |
| `ui_open` | start the private app (`headed`, `record`, `viewport`, `gpu`, `settle_timeout`), about 10 s; a second call says what is open |
| `ui_do` | steps in order, `[{"do": "tool", "label": "Extrude"}, {"do": "type", "target": "D", "text": "20"}]`, stopping at the first that fails |
| `ui_read` | screen, history, bodies, status, errors, selection or handles, as short text |
| `ui_shot` | a PNG of the page or one control, `max_px` at most 1600 |
| `ui_close` | stop the app, its browser and its engine |

The tools relay to `python -m fundacad_harness serve`, started on the first
`ui_open` with `FUNDACAD_HARNESS_PYTHON` (else `python`, or `python3` off
Windows) and handed this server's engine command. That Python needs the
package: `pip install -e tools/harness`. Without it `ui_open` says so and the
other tools work as before. The child dies with the server, inside the same
kind of job object as the engine on Windows. A call with no answer in 180 s
stops it, and the next `ui_open` starts fresh; a `ui_do` starts no step after
120 s and says which steps to send again, so a long list does not get there. No
step waits past 150 s into a call, so an import that takes longer answers
`not settled`, and `ui_read` later shows it landed.

The private app's document is its own: `doc_get` and `inspect` do not see it.
To measure what the steps built, `save_as` a `.funda` file in a `ui_do`, then
`doc_open` it and `inspect`.

`.mcp.json` stays the live server. A second entry for the private app:

```json
{ "mcpServers": { "fundacad-ui": {
    "command": "node",
    "args": ["scripts/mcp-rust.mjs"],
    "env": { "FUNDACAD_MCP_MODE": "standalone",
             "FUNDACAD_HARNESS_PYTHON": "<full path to the venv python>" } } } }
```

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
  reached across and took material out of a body it had never named. A body
  named in `targets` is acted on whether or not it is hidden in the app, only a
  feature that names none leaves hidden bodies alone.
- **A feature can only reference features above it in the timeline.**
- **A sketch outline can be written as a `polyline`**, a list of points with
  `closed: true`, and a rectangle by two corners with `from` and `to`. Neither is
  stored: the polyline becomes `line` entities `id_1`, `id_2`, … whose shared
  ends are the same values, and the rectangle its centre form, and the reply
  says so. New entities are checked when a sketch is added or its entities are
  updated, so a misspelt type or field is refused there rather than drawing
  nothing at build time. Entities sent back as `doc_get` gave them pass, and
  `doc_set` only expands the shortcuts.

## Layout

| file | what it holds |
| --- | --- |
| `src/server.rs` | the protocol and the tools |
| `src/tools.rs` | the tools' input schemas and descriptions |
| `src/ui.rs` | the ui tools and the harness child they relay to |
| `src/upload.rs` | inline `doc_import` content: decoding, pieces, archives |
| `src/link.rs` | finding and spawning the engine, its lifetime, the Windows job object |
| `src/app_session.rs`, `src/live.rs` | finding a running window and the live session |
| `src/model.rs` | the document: ids, the timeline, the parameter table, validation |
| `src/render.rs`, `src/png.rs` | the rasteriser and its PNG |
| `src/describe.rs` | turning an `inspect` report into something worth reading |
| `src/measure.rs` | the `measure` tool's request and its text |
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
