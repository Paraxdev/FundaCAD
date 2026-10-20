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
| `s.status()` | mode, running tool, workspace, document, undo and redo, prompt, selection, last message, last error |
| `s.selection()` | selected bodies, faces and edges |
| `s.last_error()` | `none` or one line |
| `s.messages(since=seq)` | log and toast lines after a sequence number |
| `s.page_errors()` | uncaught page errors seen so far |
| `s.screenshot(path=None, target=None)` | a PNG of the page or of one control, returns its path |

`screen()` regions: titlebar, menu, toolrail, history, props, items, valuebox, dialog, context,
render, views, status, other. Each line is a ref, a role, a label and flags such as `disabled`,
`on`, `selected` or `= "value"`. Refs are what actions take, for example `#undo-btn`,
`action:sketch`, `family:cat:CREATE`, `feature:e1`, `item:body1`, `field:angle`, `menu:File`.

## Troubleshooting

- `no engine found`: build one with `cargo build -p fundacad-cli`, or set `FUNDACAD_ENGINE_CMD`.
- `engine is older than the source`: rebuild it, the app and the engine may disagree otherwise.
- `this page has no harness driver`: the page is a production build or an old checkout without
  `src/harness`; the harness only drives a dev build.
- `the page driver speaks api N`: the package and the checkout are from different times, reinstall
  the package from this checkout.
- A launch failure prints the end of the engine or vite log. With `keep=True` the whole work folder
  stays: `engine.log`, `vite.log`, `page.log` (console and page errors) and `shots/`.

## The rule

Only `src/harness/` reads app internals. A test or script that needs a new readout adds it to the
driver, with a unit test under `tests/harness/`, so a renamed field breaks one typed file at compile
time instead of a script at run time.
