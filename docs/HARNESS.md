# Agent harness

`fundacad-harness` is a Python package that drives the browser build of FundaCAD the way a person
does: it clicks real controls, types into real boxes and drags real handles, then reads back a few
short lines about what happened. It is for agent tests, UX walkthroughs and assistant sessions
that need to see the app work, without writing a page script.

It lives in `tools/harness/`. The page half is `src/harness/`, a driver that is loaded only in a
dev build opened with `?harness=1`. That driver is the one place outside the app that reads app
internals; everything a session does is real pointer and keyboard input.

## Install

Any Python 3.10 or newer works. With uv:

```sh
uv venv .venv-harness --python 3.12
uv pip install --python .venv-harness -e "tools/harness[test]"
```

or into an existing venv with `pip install -e "tools/harness[test]"`. The harness never downloads
a browser: it launches an installed Chrome or Chromium.

Check what a session would start:

```sh
fundacad-harness doctor
```

It prints the engine binary and its age, the Chrome it found, node and vite, and says `ready` or
what is missing.

## A session

```python
from fundacad_harness import Session

with Session() as s:
    print(s.status())
    print(s.screen(region="toolrail"))
    s.screenshot("start.png")
```

`Session()` starts its own engine on a free port with its own token, its own vite on a free port
and a fresh headless Chrome, then waits for the app and closes the start screen (Home, or the
Welcome dialog on older trees). It never touches port 5173 or 8765, an open app window, or any
process it did not start. Leaving the `with` block, `s.close()`, an exception or interpreter exit
stops all of it.

Options:

| option | default | what it does |
|---|---|---|
| `engine=` | discovered | the engine binary or command line |
| `chrome=` | discovered | the browser binary |
| `vite_url=` | own server | use a vite server that is already running |
| `headed=` | `False` | show the browser window |
| `gpu=` | `False` | real GPU flags instead of software rendering |
| `viewport=` | `(1400, 900)` | page size in pixels |
| `keep=` | `False` | keep the work folder (logs, screenshots) after a clean close |
| `record=` | none | write the session's actions to a script that replays them, see Recording |
| `repo=` | discovered | the checkout to serve |
| `settle_timeout=` | `60` | seconds an action may take to settle |

Environment:

| variable | meaning |
|---|---|
| `FUNDACAD_ENGINE_CMD` | engine command line, `--ws` is appended (same as the MCP server) |
| `FUNDACAD_CHROME`, `SC_CHROME` | browser binary |
| `FUNDACAD_HARNESS_HEADED=1` | show the browser |
| `FUNDACAD_HARNESS_KEEP=1` | keep the work folder |
| `FUNDACAD_REPO` | the checkout, when the current folder is outside it |
| `FUNDACAD_HARNESS_PYTHON` | the Python the MCP server runs `serve` in, see MCP |

The engine is found in this order: `engine=`, `FUNDACAD_ENGINE_CMD`,
`$CARGO_TARGET_DIR/{debug,release}`, `<repo>/target/{debug,release}` (newest first), then `PATH`.
The harness never builds one. When the binary is older than the newest Rust source it prints a
warning, since testing a stale engine is an easy mistake.

The engine gets a clean environment: every inherited `FUNDACAD_*`, `SINDRI_*` and `SINDRICAD_*`
variable is removed, and its blob store and cache go to the session's work folder.

## Readouts

Every readout is a few lines of text. Pass `raw=True` for the JSON it was made from.

| call | what it shows |
|---|---|
| `s.screen(region=None)` | the visible controls as a short tree, one ref per control |
| `s.history()` | the features, their type and any error, suppressed or rolled back state |
| `s.bodies()` | bodies with face count and visibility |
| `s.status()` | mode, running tool, workspace, document, undo and redo, prompt, selection, the newest message and error since the last action began |
| `s.selection()` | selected bodies, faces and edges |
| `s.handles()` | the named handles a tool has up, with their screen point or `covered` |
| `s.last_error()` | a failed build or refused preview, else an error logged since the last action began, or `none` |
| `s.messages(since=seq)` | log and toast lines after a sequence number |
| `s.page_errors()` | uncaught page errors seen so far |
| `s.screenshot(path=None, target=None)` | a PNG of the page or of one control, returns its path |

`screen()` regions: titlebar, menu, toolrail, history, props, items, valuebox, dialog, context,
render, views, status, other. Each line is a ref, a role, a label and flags such as `disabled`,
`on`, `selected` or `= "value"`. Refs are what actions take, for example `#undo-btn`,
`action:sketch`, `family:cat:CREATE`, `feature:e1`, `item:body1`, `field:angle`, `menu:File`.
An Items folder that is no element, such as a node of an imported assembly, is
`folder:<tree key>`, and the eye on a row or folder is `eye:<id or key>` with the row's label and
a `visible` or `hidden` flag. Eyes are never matched by label, only by ref.

## Actions

Every action is real pointer or keyboard input, waits until the app has settled (rebuilds,
previews, the camera and the picture all quiet), and returns a `Step`: one line saying what was
done and what the app shows now, including what it said while the action ran (`said info "Create
or import a body first"`) and any error, with the JSON behind it in `step.data`. Pass
`settle=False` to look at the app mid flight.

```python
with Session() as s:
    s.open_file("tools/harness/fixtures/plate.json")
    s.view("iso")
    s.pick_face("top")
    s.tool("Press/Pull")
    s.type("D", "7")
    s.press("Enter")
    print(s.history())
    s.undo()
```

| verb | what a person does |
|---|---|
| `click(target, button="left", double=False, mods=())` | clicks a control by ref or label, or `face:<sel>` / `edge:<sel>` on the canvas |
| `tool(label)` | starts a rail tool, opening its category or family first |
| `type(target, text, enter=False)` | clicks a value box, selects all and types |
| `press(*keys)` | `"Enter"`, `"Escape"`, `"Ctrl+Z"`, `"Shift+H"` |
| `menu(path)` | `"File/Open..."`, three dots or the ellipsis both work |
| `context_menu(on, item)` | right clicks a control or `face:<sel>`, then the row |
| `panel(name, open=True)` | history, items, preferences and the other panel buttons, only if not already in that state |
| `command(name)` | Ctrl+F, the name, Enter |
| `pick_face(sel, add=False, exact=False)` | clicks a face; a click that took the body is followed by a second one, as a person does |
| `pick_edge(sel, add=False, exact=False, via="select")` | clicks an edge, `via="edge"` for the edge tools |
| `pick_plane(name)` | `XY`, `XZ`, `YZ` or a datum plane's id |
| `click_at(sketch=(x, y) or world=(x, y, z))`, `drag(from_, to, space="sketch")` | pointer at a sketch or world point |
| `drag_handle(name, by=px or mm=value)` | drags a named handle along its axis |
| `view(name)` | iso, top, front, right, ..., fit, through the Views popover |
| `undo()`, `redo()` | the title bar buttons |
| `expand(target, open=True)` | opens or closes an Items folder by its caret (a click on the row selects) |
| `open_file(path)` | File > Open, answering the file chooser |
| `import_file(path)` | drops the file on the canvas, the way a browser tab imports a model |
| `save_as(path)` | File > Save As, the download lands at `path` |
| `new_document(discard=True)` | Ctrl+N, answering the unsaved changes question |
| `settle(trace=None, timeout=None)`, `wait_for(text, timeout=10)` | explicit waits, `wait_for` looks at the prompt, the screen and the messages logged since the last action began |

Labels match the visible text without its key hint, case insensitive, exact before prefix,
visible and enabled controls only. When a label matches several controls the error lists their
refs; refs never change with wording. `#n` picks the n-th of several.

### Selectors

`[<body>:]<words>`, the body is an id or a name and can be left out when there is one body.

- Faces: `top`, `bottom`, `front`, `back`, `left`, `right` (Z up, front faces -Y), `+x` to `-z`,
  `normal=x,y,z`, `largest`, `smallest` (optionally `planar` or `curved`), `near=x,y,z`,
  `index=n` (the MCP `inspect` numbering).
- Edges: `near=x,y,z`, `between <face> <face>`, `longest`, `shortest`.
- Handles: extrude `depth`, press pull `push`, fillet and chamfer `size`, offset face and offset
  plane `offset`, draft `angle`, joint `offset` and `angle`, mechanism `offset` or `angle`, revolve
  pitch `pitch`, section `section`, selection nudge `nudge`, taper arcs `taper`, datum `arrow`,
  `tilt x`, `tilt y`, `spin`, Move `arrow x|y|z`, `plane xy|yz|xz`, `ring x|y|z`, `size x|y|z`,
  `origin`. `s.handles()` lists the ones on screen.

Every canvas point is checked with the app's own picker before the click, and points under a
panel or a handle are skipped. When no point works the call fails with `Occluded` and suggests a
view; the harness never turns the camera by itself.

## Settling

After each action the driver waits until the app is quiet: the engine socket open, no rebuild
pending or running, no long operation, no geometry request in flight (tool previews are requests
too), and the viewport neither drawing nor moving the camera. All of that has to hold on 3 frames
in a row with nothing new in the document, the build or the log for 150 ms, which also covers a
tool that makes its edit a moment after the click. `s.settle(trace=N)` waits for the path traced
view to reach N samples as well. After 60 s (`settle_timeout=`) it fails with `SettleTimeout` and
one line on what is still busy, for example `building, 2 requests in flight, socket open`.

If vite reloads the page once while it optimises dependencies on a cold start, the session waits
for the app again and closes the start screen again. A second reload is an error.

## Recording

`Session(record="walk.py")` writes every action to `walk.py` as it happens, and `python walk.py`
plays it back in a new session:

```python
# Recorded by fundacad-harness 0.1.0, driver api 1, 2026-10-20.
from fundacad_harness import Session

with Session() as s:
    s.open_file("tools/harness/fixtures/plate.json")
    s.view("iso")
    s.pick_face("top")
    s.tool("Press/Pull")  # action:offer:presspull
    s.type("field:distance", "4", enter=True)  # "D"
```

A control found by its label is written by its ref, with the label in a comment, so a relabelled
button still replays. Face and edge selectors, tool labels and menu paths stay as written. A file
inside the checkout is written relative to it. Readouts are not recorded, `wait_for` is. A failed
action is left out, and an action called from inside another one is written once.

## Examples

`tools/harness/examples/` holds ports of e2e scripts, each a `run(s)` function plus a `__main__`
that opens its own session: `assembly_tree.py` (a dropped STEP assembly in Items, a subassembly
eye, save and reopen), `refused_commit.py` (a refused draft keeps the tool open), and
`extrude_reedit.py` (reopening a whole sketch extrude). `tests/browser/test_examples.py` runs them
in the smoke set. The fixtures they open are described in `tools/harness/fixtures/README.md`.

## serve

`fundacad-harness serve` (or `python -m fundacad_harness serve`) holds one session and answers
one JSON object per line on stdin, which is how the MCP server drives it. stdout carries only
replies, logs go to stderr, and the session closes when stdin ends.

```json
{"id": 1, "call": "open", "args": {"viewport": "1400x900"}}
{"id": 2, "call": "do", "args": {"steps": [{"do": "tool", "label": "Revolve"}, {"do": "press", "keys": "Escape"}]}}
{"id": 3, "call": "read", "args": {"what": ["history", "errors"]}}
{"id": 4, "call": "shot", "args": {"max_px": 1000}}
{"id": 5, "call": "close"}
```

Each reply is `{"id", "ok", "text"}`, plus `"png"` (base64) for `shot`. A `do` runs its steps in
order and stops at the first that fails, with one line per step and the status. A step names its
verb in `do` and the verb's arguments by their Python names (`from` for `drag`); unknown keys are
refused by name. `read` takes screen, history, bodies, status, errors, selection and handles.
The MCP server gives up on a call after 180 s and loses the session, so a `do` starts no step
after 120 s and says which steps to send again, and a `wait_for` step waits at most 60 s.

## MCP

The MCP server in standalone mode (`FUNDACAD_MCP_MODE=standalone`) offers the same session as five
tools, `ui_open`, `ui_do`, `ui_read`, `ui_shot` and `ui_close`, relayed to `serve` in a Python
named by `FUNDACAD_HARNESS_PYTHON`. A `ui_do` step is a `do` step as above. Install the package
into that Python, then see [MCP.md](MCP.md#driving-the-app-standalone-only) for the `.mcp.json`
entry. Auto and attach never offer these tools.

## Porting an e2e script

The scripts in `e2e/*.cjs` reach into `window.store`, `window.tree` and the tools' own fields, so
they break silently when a field moves. A port says what a person does and reads what a person
sees:

| the script does | the harness does |
|---|---|
| `store.addFeature(...)` or a tool's `commit()` | `s.tool("Extrude")`, `s.type("D", "20")`, `s.press("Enter")` |
| `page.mouse.click(x, y)` at a computed point | `s.pick_face("top")`, `s.click_at(sketch=(10, 5))`, `s.drag_handle("depth", mm=5)` |
| `waitForFunction(() => !store.buildState.building)` | nothing, every action settles |
| `store.doc.features.map(...)` | `s.history()` |
| reading `tree` or the Items DOM | `s.bodies()`, `s.screen(region="items")` |
| `page.screenshot()` on every step | `s.screenshot()` only when the look matters |

Open a fixture document with `s.open_file(...)` rather than building one in page code, keep the
asserts on readout text, and put the port in `tools/harness/examples/` with a test in
`tests/browser/`. The old script stays until the port has been green in CI for a while.

## Troubleshooting

- `no engine found`: build one with `cargo build -p fundacad-cli`, or set `FUNDACAD_ENGINE_CMD`.
- `engine is older than the source`: rebuild it, the app and the engine may disagree otherwise.
- `this page has no harness driver`: the page is a production build or an old checkout without
  `src/harness`; the harness only drives a dev build.
- `the page driver speaks api N`: the package and the checkout are from different times, reinstall
  the package from this checkout.
- A launch failure prints the end of the engine or vite log. A launch failure, or an exception out
  of a `with Session()` block, keeps the logs in the work folder: `engine.log`, `vite.log`, `page.log`
  (console and page errors) and `shots/`. With `keep=True` the engine's blobs and cache stay too.
  A refused action that the script catches keeps nothing.

## The rule

Only `src/harness/` reads app internals. A test or script that needs a new readout adds it to the
driver, with a unit test under `tests/harness/`, so a renamed field breaks one typed file at compile
time instead of a script at run time.
