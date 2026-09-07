# Plugins

Optional pieces of the app, each one declaring what it reaches before it does
any reaching. Preferences ▸ Plugins is the whole user-facing surface, and it has
two halves.

**In the app.** Capabilities that ship inside FundaCAD and are turned on and
off: the printer connection, the 3D mouse, and multi-material. Off means the
code is never loaded, the menus and ribbon entries are gone, and on the Rust
side the 3D-mouse reader never opens the device.

**Downloaded.** Plugins that arrive from this project's releases and are agreed
to before they are fetched. The first is the MCP server (`docs/MCP.md`), which
was already a separate process talking a defined protocol; it just was not
called a plugin yet.

## The promise

One sentence, and everything else here is machinery for keeping it:

> **The promise made at install is the promise enforced, and a change to the
> promise is a change you see.**

A plugin declares what it wants to reach. That declaration IS the install
screen. A bundle that arrives asking for more than the screen said is refused
and deleted, at the point where it would otherwise have been unpacked into
place.

## What a plugin is

Four kinds, differing in where the code runs and therefore in what, if
anything, contains it. They share one permission vocabulary.

| kind | where it runs | sandboxed by |
| --- | --- | --- |
| `builtin` | inside the app, as the app | *nothing, and it does not pretend otherwise* |
| `process` | its own OS process, stdio | *nothing yet, and the install screen says so* |
| `panel` | an opaque-origin iframe, `default-src 'none'` | the browser |
| `compute` | a Worker with no fetch, no DOM | the browser |

`builtin` and `process` exist today. A built-in is the app's own code and gets
no boundary at all; what it gets is a description, on the same screen and in the
same words as everything else, and a switch that really stops it. Putting it in
the same vocabulary rather than a separate "features" checkbox is deliberate:
the question a person is answering is the same one, and two vocabularies for
one question produce two screens that describe the same reach differently. What
a built-in must never do is borrow the language of enforcement, which is what
`sandboxNote("builtin")` exists to prevent.

**A process plugin is not in a cage, and pretending otherwise would be worse
than not claiming it.** A separate process runs as the user; the OS boundary
keeps it out of the app's memory, not out of the user's files. What its grants
describe is what it can reach *through the app*, plus a promise about the rest.
The install screen says exactly that, for process plugins and only for process
plugins. Per-platform sandboxing (AppContainer, seatbelt, bubblewrap) is a
later phase, and until it lands the sentence stays.

## Grants

A closed vocabulary in `src/plugins/manifest.ts`. A manifest naming a grant
that is not in the table is **refused at parse**, not ignored: an unknown grant
means the app cannot say what the plugin wants, and the only safe reading of
that is no.

| grant | the sentence on the screen |
| --- | --- |
| `document.read` | Read the document you have open |
| `document.write` | Change the document you have open |
| `document.history` | See your edit history |
| `geometry.build` | Use the geometry engine to build and measure shapes |
| `files.read` | Read files you pick for it |
| `files.write` | Save files where you tell it to |
| `network` | Connect to *(the hosts it names)* |
| `printer.control` | Send jobs to your printer and read its status |
| `device.input` | Read the 3D mouse or other input device you have plugged in |
| `ui.panel` | Add a panel to the window |
| `process.spawn` | Start other programs on your computer |

`network` is the only parameterised one and it takes **hosts, not a boolean**.
"Can use the internet" is not a decision anyone can make; "can connect to
`api.example.com`" is.

The install screen shows **two** lists: what the plugin asked for, and what it
did not. The second is the one worth reading, and it is generated from the same
table, so the reassuring half cannot go stale while the alarming half stays
current. Hand-written reassurance goes stale silently and in the direction that
hurts.

## The three built-in capabilities

| id | what it is | asks for | on by default |
| --- | --- | --- | --- |
| `printing` | printers on your network, and opening a model in a slicer | `document.read`, `files.write`, `printer.control`, `process.spawn` | yes |
| `spacemouse` | navigating and moving with a 3D mouse | `device.input`, `document.read`, `document.write` | yes |
| `multi-material` | filament slots, per body and per texture colour | `document.read`, `document.write` | no |

The two that were always in the app default to on. An upgrade that silently
removed a working printer connection would be a regression wearing the word
"plugin"; multi-material was already off and stays off.

Some of the grant choices are worth stating, because the tempting answer is the
wrong one in each case:

- **`printing` claims `process.spawn`.** Opening a model in a slicer starts
  another program on the machine, and that is the most consequential thing
  anything in this app does on the user's behalf.
- **`printing` does not claim `network`.** It reaches printers configured in
  this app, over the local network. "Connect to the internet" would be a worse
  description rather than a more cautious one.
- **`spacemouse` claims `document.write`.** Its object mode moves the selected
  body, and a move is an edit. Omitting it because the edit arrives through a
  knob rather than a dialog would be describing the input device instead of the
  effect.
- **`spacemouse` does not claim `process.spawn`**, and neither does the MCP
  plugin. A vocabulary whose grants are claimed whenever they are technically
  defensible is one where every screen looks the same.

### What "off" actually means

Not a hidden menu. Each capability's code is behind a dynamic `import()`, so the
bundler gives it a chunk of its own and a capability that is off is never
fetched, never parsed and never run. Turning one off while the app is running
takes effect immediately: `activate()` returns a teardown, and the frame loop,
the event listeners and the Rust-side device handle all go with it.

`tests/plugins/coreIndependence.test.ts` is what keeps this true. It reads every
file under `src/` and fails if anything outside a capability's own files
statically imports one of them, because a single convenient `import` would put
the code back in the bundle everyone downloads while the switch went on saying
it was off.

Multi-material is the exception and is not in the loader: it has no listeners,
no device and no process, only gates read where the work happens (the document
store, the browser tree, the exporters), so there is nothing to hand a teardown
for. Its code is not separately chunked, and this document should not imply it
is.

Whatever a capability owns in the document survives being turned off. Slot
assignments are saved, loaded and exported exactly as before, so turning
multi-material back on finds the work still there. A toggle that ate data would
not be a toggle.

## Where a plugin comes from

An official plugin is an asset on this repository's own releases, published by
the release job alongside the installers. There is no index and no served
catalogue: the plugins a build offers are compiled into that build
(`src/plugins/index.ts`), and Rust refuses any download URL outside
`https://github.com/Paraxdev/fundacad/releases/download/`
(`src-tauri/src/plugins/bundle.rs`). A document whose only job is to be trusted
is a document that can lie; not having one is cheaper than defending it.

The download happens in Rust rather than the webview. The content security
policy names the loopback engine and nothing else, and widening it so a
`fetch()` could reach the releases host would open that host to every script in
the window for the sake of one download.

## Installing, step by step

1. The screen renders the built-in entry's permissions. Nothing is downloaded
   until it is answered.
2. Fetch over HTTPS from the releases host. This is where authenticity comes
   from. A `sha256` may be passed and is enforced when it is, but a build
   cannot carry the digest of an asset republished after it shipped, so the
   digest of what arrived is recorded rather than demanded.
3. Unpack into `<app data>/plugins/.staging-<id>/`. Every entry that would
   escape that directory is refused: `..`, absolute paths, drive letters,
   backslashes, symlinks, and archives over the entry-count or unpacked-size
   limits.
4. Read the bundle's own `plugin.json` and compare kind, grants and hosts
   against what the screen showed. A mismatch is refused **by name** and the
   staging directory is deleted.
5. Only then does the staging directory become `<app data>/plugins/<id>/`.

A failure at any step leaves whatever was installed before exactly as it was.

`installed.json` lives inside the plugin's own directory rather than in a
settings key, so deleting the directory really does uninstall it. A directory
with no readable record is not reported as installed: nobody has a record of
agreeing to whatever is in there.

## Where the code is

| file | what it holds |
| --- | --- |
| `src/plugins/manifest.ts` | the vocabulary, the parser, the two lists, the promise |
| `src/plugins/registry.ts` | the built-in capabilities, and which are on |
| `src/plugins/activate.ts` | starting and stopping them, by dynamic import |
| `src/plugins/builtin/*.ts` | one activation module per capability |
| `src/plugins/index.ts` | the plugins this build offers, and the bridge to Rust |
| `src/components/overlays/PluginsSection.vue` | Preferences ▸ Plugins |
| `src-tauri/src/plugins/mod.rs` | the commands: list, install, remove, python runtime |
| `src-tauri/src/plugins/bundle.rs` | the refusals, split out so they can be tested |
| `scripts/build-plugin-mcp.py` | packaging, run by the release job |

The Rust side knows **nothing** about what a grant means, and must not learn.
It compares grant sets as opaque strings. Teaching both sides the meaning of a
grant would give them two chances to disagree about it.

## Tests

`bundle.rs` carries the refusals and their controls. On Linux CI they run with
everything else; on a Windows box the app's own test binary cannot start (it
links the webview stack and dies with `STATUS_ENTRYPOINT_NOT_FOUND` before the
first test), so `scripts/check-plugin-guards.sh` compiles that one file in a
crate with no Tauri in it and runs the same tests. It then builds the real MCP
bundle and unpacks it with the real extractor, which is the only test that
covers the packaging script and the guard together.

```sh
sh scripts/check-plugin-guards.sh
npx vitest run tests/plugins tests/components/overlays/PluginsSection.spec.ts
```

## What comes next

1. A broker: one door, one grant check, every op belonging to exactly one
   grant, with an exhaustiveness test whose control is an op deliberately left
   out of the table. MCP moves onto it, so it is a plugin in fact and not only
   in the Preferences list.
2. Panel plugins, and the first one built on them.
3. Compute plugins, which is also the answer to "can I script this".
4. OS sandboxing for process plugins, per platform.
5. Third-party publishing: signing, revocation, and a publisher who is not us.
