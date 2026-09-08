# Plugins

Optional pieces of the app, each one declaring what it reaches before it does
any reaching. Preferences ▸ Plugins is the whole user-facing surface, and it has
two halves.

**In the app.** Capabilities that ship inside FundaCAD and are turned on and
off: the printer connection, the 3D mouse, and multi-material. Off means the
code is never loaded, the menus and ribbon entries are gone, and on the Rust
side the 3D-mouse reader never opens the device.

**Installed.** Plugins that arrive from somewhere, and are agreed to before
they run. From this project's releases, from any HTTPS URL, or from a zip
already on the disk; once installed those are the same kind of thing, and the
screen says which it was. The first is the MCP server (`docs/MCP.md`), which was
already a separate process talking a defined protocol; it just was not called a
plugin yet.

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

## Where a plugin's source lives

Each plugin is one directory under `plugins/`, with a `plugin.json` at its top
level. That is the entire rule, and it is what `scripts/build-plugins.py`
discovers: adding a second plugin means adding a directory, not editing a
script, a workflow or a list. A directory without a manifest is skipped rather
than packaged into something that cannot be installed.

`plugins/` is a plugin's OWN source, separate from `src/plugins/`, which is the
app's side of the arrangement: the vocabulary, the broker, the registry and the
screen. Nothing in `plugins/` is compiled into the app.

The packaging script refuses a bundle that could not work once installed: a
manifest whose `id` disagrees with the directory name (it would install under
one name and be looked for under another), an unknown kind, or a missing entry
point for the kind it claims. A bundle missing its entry point installs
perfectly and then does nothing, which is the most annoying shape a failure can
have.

One consequence worth writing down, because it broke on the way here: nothing
should work out where the repository root is by counting directories up from
itself. `sidecar_link.py` did, with two `dirname` calls that meant "the
checkout" only while the plugin sat one level down. It searches upward for a
`sidecar/server.py` now, and finds nothing when installed under the app data
directory, which is exactly when the environment override is supposed to take
over.

## Where a plugin comes from

Three routes in, and they differ only in where the manifest is read from.

1. **A suggestion we ship.** The short list compiled into the build
   (`src/plugins/index.ts`). Its manifest is known before anything is fetched,
   so there is nothing to download in order to decide.
2. **A URL.** Any HTTPS URL. The only account of what the bundle wants is
   inside the bundle, so it is fetched and unpacked to be read, and only then
   described on a screen.
3. **A zip on disk.** Read the same way, through the same pipeline.

There is no index and no served catalogue, and there will not be one: a
document whose only job is to be believed is a document that can lie, and the
suggestions cost nothing to carry in the build.

**Any HTTPS URL is a widening, and a deliberate one.** The check used to admit
only this repository's releases. That was never the thing making a plugin safe
— the grants it declared and the sandbox its kind runs in are — and an origin
allowlist containing only ourselves is not a permission model, it is a
distribution monopoly wearing one. What survives is the part that was always
doing the work: `allowed_bundle_url` insists on HTTPS and on an authority that
means what it reads, refusing userinfo (`https://github.com@evil.example.com/…`
resolves nowhere near GitHub), non-numeric ports, whitespace, control
characters and anything that is not a host.

HTTPS is the non-negotiable half. Over plain HTTP the bytes are whatever the
network decided they should be, and the digest check, the manifest comparison
and the extractor would all then run faithfully against an attacker's archive.
It is also what makes the origin on the consent screen worth showing: with TLS,
the host in the URL is the host that answered. **Every redirect hop is checked
too**, not just the URL that was typed — otherwise an approved host could
answer `302` to plain HTTP and the check would have secured one request out of
two.

**"Official" is a label, not a permission.** `is_official_url` answers only
whether we published it. It is decided in Rust from the URL the bytes actually
came from, stored on the record, and shown on the row. It skips no screen,
grants nothing, and a bundle claiming it in its own manifest is ignored — a
bundle claiming to be ours is precisely the one that must not be believed for
saying so.

The download happens in Rust rather than the webview. The content security
policy names the loopback engine and nothing else, and widening it so a
`fetch()` could reach an arbitrary host would open every host to every script
in the window for the sake of one download.

## Installing, step by step

**Reading first, for anything not already described.** The consent screen has to
say what a plugin asks for before it is installed, and for a bundle nobody has
seen, the only account of that is inside it. So `plugin_inspect_url` /
`plugin_inspect_file` fetch or read it, unpack it into a scratch directory, read
one file, and delete the directory again. Fetching is not running: nothing is
executed, nothing is left behind, nothing is recorded as installed, and the
extractor's refusals all apply exactly as they do on the real thing, because it
is the same function.

The digest of what was read comes back and is passed down as a pin when the
install happens. The install is a second fetch, and between the two the asset
could change; without the pin the screen would have described one bundle while
another was installed.

Then, for all three routes:

1. The screen renders the manifest's permissions, and the origin. Nothing is
   installed until it is answered.
2. Fetch over HTTPS, or read the file. A `sha256` is enforced when given, and
   the inspect step gives one. A build cannot carry the digest of an asset
   republished after it shipped, so for a suggestion installed without an
   inspect, the digest of what arrived is recorded rather than demanded.
3. Unpack into `<app data>/plugins/.staging-<id>/`. Every entry that would
   escape that directory is refused: `..`, absolute paths, drive letters,
   backslashes, symlinks, and archives over the entry-count or unpacked-size
   limits.
4. Read the bundle's own `plugin.json` and compare kind, grants and hosts
   against what the screen showed. A mismatch is refused **by name** and the
   staging directory is deleted. This is the step a local file does not get to
   skip: if picking a file bypassed it, picking a file would be the way around
   the consent screen.
5. Only then does the staging directory become `<app data>/plugins/<id>/`.

A failure at any step leaves whatever was installed before exactly as it was.

`installed.json` lives inside the plugin's own directory rather than in a
settings key, so deleting the directory really does uninstall it. A directory
with no readable record is not reported as installed: nobody has a record of
agreeing to whatever is in there.

## The screen

Preferences ▸ Plugins is driven by **what is installed**, not by what shipped.
A plugin from our releases, from a URL somebody was given, and from a zip on
disk are all the same kind of row once installed; the suggestions appear
underneath as things not installed yet, which is all they are.

The origin is shown for anything we did not publish, and only then — a label on
every row is a label nobody reads. It sits above the two permission lists rather
than below them, because it is the half of the question a person can actually
judge, and a note underneath an argument is a note read after the decision.

A row whose record will not parse is not described at all. `installedManifest`
returns null and the screen says so plainly, because a row that cannot be
described accurately must not be described reassuringly.

## The broker: one door

Everything a plugin does to the app goes through one function, and the grant
check happens there. The value of that is not that the check is clever, it is
three lines, but that there is exactly one of it. A permission model with two
entry points has two, and the second one is the one nobody audits.

**The vocabulary is the MCP server's tool names, unchanged.** Sixteen ops:
`schema`, the five `doc_*`, the two `param_*`, the four `feature_*`, `build`,
`inspect`, `view`, `export`. That server already speaks a defined protocol over
a token-gated socket and already has a schema for each of these. A second
vocabulary here would need a translation table, and a translation table is a
place for the two halves to disagree about what `feature_move` means. There is
one vocabulary and MCP is a transport for it.

**An op names every grant it needs, not the most interesting one.** An earlier
sketch had one grant per op, which reads well and is false: `doc_open` reads a
file AND replaces the open document, `export` needs three, and the one-grant
version would have let a plugin holding only `geometry.build` call `build` and
read the open document's body sizes back out of the answer. `build`, `inspect`,
`view` and `export` all carry `document.read` for exactly that reason.

**An op that is not in the table is refused**, exactly as an unknown grant is
refused at parse. A broker that passed through what it did not recognise would
have a hole shaped like every op added after it was written.

**Nothing throws at a plugin.** A refusal is a value with a reason in it, and a
host that throws is caught and becomes one: an exception crossing out of
untrusted code into the app's stack is a plugin's bug becoming the app's crash.
`callOrThrow` is the plugin's own opt-in for code that would rather write
straight lines, and it exists because the version a plugin author writes
otherwise is `(await b.call(op)).value`, which reads `undefined` off a refusal
and fails ten lines later as a TypeError naming neither the op nor the missing
grant.

`tests/plugins/broker.test.ts` reads the op list out of `plugins/mcp/server.py` rather
than restating it. Two copies of a list drift: someone adds a tool there, nobody
adds a row here, and the new tool is either unreachable or reachable without a
permission.

## Testing a plugin

A plugin is handed a broker and nothing else, so what a plugin's tests need
injected is one host, not a mock of every part of the app.

```ts
const app = testBroker({ grants: ["document.write"] });
await app.callOrThrow("feature_add", { feature: { type: "box", x: 40 } });
expect(app.host.document().features).toHaveLength(1);
```

No Tauri, no webview, no geometry process, no window.
`tests/plugins/exampleUse.test.ts` is that written out as a plugin author would
write it, run as a test so it cannot rot.

**The document ops are real.** Parameters and the timeline are plain data with
rules over them, so the double runs those rules: ids are assigned the way the
app assigns them (checked against `plugins/mcp/model.py`, so the two cannot drift), a
bad edit is refused before anything is written, and a plugin that adds a feature
and reads the document back sees it.

**The four that need the kernel refuse rather than pretend.** `build`,
`inspect`, `view` and `export` need OCCT in a separate process, which a unit
test does not have. They are answered from `answers`, which the test supplies,
and the default refusal names the option to set. A canned bounding box would let
a plugin's test pass while the plugin's arithmetic was wrong, and it would pass
forever, because nothing in the test ever touched a solid.

The narrower grant set is worth using in a plugin's own tests, not just the
default: the second case every plugin should have is that it fails honestly when
it does not hold what it asked for, which is the case an author otherwise never
runs and a user eventually does, having turned something off.

## The sandbox a compute plugin runs in

A compute plugin is a Worker with one port. It has no DOM, no app, and nothing
to reach except the broker at the other end of that port. What it may ask for
there is checked against the grants recorded at INSTALL, not against anything it
says at run time: the host sends the plugin its grant list so it can plan, and
that copy is advice. A plugin editing it changes nothing.

### How a plugin's code gets into the Worker

The obvious way is a static Worker that receives the plugin's text and hands it
to the Function constructor. It works, and it would tie every compute plugin to
`'unsafe-eval'` in the policy. That grant exists here for exactly one unrelated
reason, planegcs, and `tests/security/csp.test.ts` is written to fail when
planegcs stops needing it so it gets removed. A plugin system quietly depending
on it would make that removal impossible, and nobody would find out until they
tried.

So the plugin's text is inlined into the Worker's own script instead. That
script is a blob; it imports the sandbox bootstrap from the app's own origin and
calls what the bootstrap registered:

```js
import "<the app's sandbox chunk>";
self["__fundacadStartPlugin"](async function (app) {
  // the plugin
});
```

That needs `worker-src 'self' blob:` and nothing else. `worker-src` is a
separate directive from `script-src`, which is the point of using it: a blob may
become a Worker, which has no DOM and one port, and may not become a script in
the page, which has everything.

**Measured, not assumed.** `e2e/sandbox_csp.cjs` runs this in a real browser
under the policy read from `tauri.conf.json`, with `'unsafe-eval'` stripped out
of it, and checks that the sandbox starts, has no DOM, compiles WebAssembly, and
is refused an op it did not ask for. It carries a control that removes the
`worker-src` grant and must fail.

Inlining untrusted text into a script would be alarming anywhere else and is not
here. A plugin that closes the wrapper early lands at the Worker's top level
with exactly the same nothing available to it. The boundary is the Worker.

### What the host defends against

A plugin does all of these the first time its author writes a loop wrong, so
they are conditions to survive rather than attacks to report.

| | |
| --- | --- |
| a message that is not one | dropped, never partially acted on |
| a plugin that never finishes | a deadline, after which the Worker is terminated |
| a plugin holding slow work open | a cap on ops in flight |
| a plugin that calls without pause | a cap on ops in total |
| a plugin that logs a river | lines truncated, and a cap on how many are kept |
| a plugin that speaks after `done` | ignored; the run is over once it is over |

The in-flight cap is about **concurrency, not rate**, and the difference is easy
to get wrong. An op that answers immediately never accumulates: its reply drains
before the next message is even delivered, so a plugin can make a thousand quick
calls with one outstanding throughout. What that cap bounds is many *slow* ops
held open at once.

### Where the runner is

| file | what it holds |
| --- | --- |
| `src/plugins/runner/protocol.ts` | the messages, and the parsers that refuse anything else |
| `src/plugins/runner/host.ts` | the app's end: the broker, the limits, the deadline |
| `src/plugins/runner/guest.ts` | the plugin's end: `app`, and the pending-call bookkeeping |
| `src/plugins/runner/sandbox.ts` | the module the Worker imports |
| `src/plugins/runner/spawn.ts` | the generated script, the blob, the Worker |

The host and the guest are wired to a `MessageChannel` in
`tests/plugins/sandbox.test.ts` and run in one process. That is not a stub of
the arrangement, it is the arrangement: same modules, same messages, same
serialisation. What a Worker adds is isolation, which is the browser's and is
what the e2e test above is for.

**One thing a unit test could not have caught.** Vite builds `sandbox.ts` as a
worker *entry*, and an entry has no importers, so Rollup treats every export as
unreachable and drops it. The first build produced a chunk holding the op-name
array and no sandbox at all — past every test, and it would have failed at the
first line of the first plugin anybody ran. The bootstrap registers itself with
a top-level assignment now, which a bundler must keep, and
`scripts/check-sandbox-chunk.mjs` reads the built artifact and fails if it is a
husk again.

## The two hosts

`BrokerHost` has two implementations, and they serve the same op table.

| | |
| --- | --- |
| `src/plugins/broker/appHost.ts` | the document the window has open |
| `src/plugins/broker/testing.ts` | an in-memory app, for a plugin's own tests |

Every edit in `appHost` goes through `DocumentStore`, never around it, so a
plugin's change is one undo step, re-runs the parameter cascade, triggers the
rebuild, and is watched by the person it is happening to.

`tests/plugins/appHost.spec.ts` runs the same script of ops through both and
compares the documents that come out. That test is what makes a plugin's own
tests worth anything, and it earned its place immediately: the two disagreed
about what `param_set` replies with, because the real store validates
synchronously and commits asynchronously and so cannot hand back the evaluated
number. The double no longer promises one either.

The same test also fixed a thing this document previously got wrong. There is
more than one id scheme here: `plugins/mcp/model.py` names features by type
(`bx1`, `ex1`) and the app names them `f1`, `f2`, counting from what it already
has. Both are hosts for one op vocabulary and both are right. The lesson holds
either way: **read the id `feature_add` returns, never predict it.**

### What appHost does not serve yet

`doc_open`, `doc_save` and `export` need a file picker; `build`, `inspect` and
`view` need the geometry engine. Each refuses by name. A plugin author has to be
able to tell "you did not ask for this" (the broker, `not-granted`) from "the
app cannot do this yet" (the host, `failed`), and one refusal that could mean
either is worth much less than two that cannot.

## Languages, and what runs them

A plugin's language is a compiler choice, not an architecture. There are **two
runners**, and the kind decides which.

| written in | compiles to | runs in | kind |
| --- | --- | --- | --- |
| TypeScript | JavaScript | a Worker | `compute` |
| Rust | WebAssembly | a Worker | `compute` |
| Python | nothing | its own process | `process` |

WebAssembly compiles inside the sandbox — the e2e test checks it, because
`'wasm-unsafe-eval'` is inherited by the Worker and it would be unpleasant to
discover otherwise later. What is not written yet is the loader that hands a
`.wasm` its imports and calls into it, so a Rust plugin is a design with its
foundation in place rather than something that runs today.

**Rust means `wasm32`, not a native library.** A dynamic library loaded into the
app process is not a sandbox that needs tightening, it is the absence of a
boundary: it gets the whole address space and the user's full privileges. Rust
also has no stable ABI, so a plugin built against a different compiler version
can corrupt memory rather than fail to load, and a native-code loader breaks
macOS notarisation and the hardened runtime. WebAssembly gives one artefact for
all three platforms instead of a per-plugin build matrix.

The size argument runs the opposite way from the obvious one. Embedding a wasm
runtime in Rust would add tens of megabytes to the installer to duplicate an
engine already in the process: the webview has a JIT'd one, and the policy in
`src-tauri/tauri.conf.json` already permits instantiating it.

**Python reuses what exists.** The app already ships an interpreter and hands it
out (`plugin_python`), already speaks a token-gated protocol on loopback, and
`sidecar/live_session.py` already implements the mediation a permission model
needs: one host owns the document, guests propose replacements against a
revision and cannot install one. A Python plugin is a guest. A second Python
runner would be a second thing to be wrong.

What Python does not get is a claim of containment. A process runs as the user,
and the `process` sentence on the install screen says so.

## Where the code is

| file | what it holds |
| --- | --- |
| `src/plugins/manifest.ts` | the grant vocabulary, the parser, the two lists, the promise |
| `src/plugins/broker/ops.ts` | the op vocabulary: what each needs, and why |
| `src/plugins/broker/broker.ts` | the door: check, then dispatch, and never throw at a plugin |
| `src/plugins/broker/appHost.ts` | the same door onto the document that is open |
| `src/plugins/broker/testing.ts` | the app a plugin's tests are handed |
| `src/plugins/runner/*.ts` | the sandbox: protocol, host, guest, spawn |
| `src/plugins/registry.ts` | the built-in capabilities, and which are on |
| `src/plugins/activate.ts` | starting and stopping them, by dynamic import |
| `src/plugins/builtin/*.ts` | one activation module per capability |
| `src/plugins/index.ts` | the plugins this build offers, and the bridge to Rust |
| `src/components/overlays/PluginsSection.vue` | Preferences ▸ Plugins |
| `src-tauri/src/plugins/mod.rs` | the commands: list, inspect, install, remove, python runtime |
| `src-tauri/src/plugins/bundle.rs` | the refusals, split out so they can be tested |
| `plugins/<id>/` | each plugin's own sources, one directory each |
| `scripts/build-plugins.py` | packaging, run by the release job |

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
npx vitest run tests/plugins tests/security/csp.test.ts
node scripts/check-sandbox-chunk.mjs     # needs a build; runs one if there is none
node e2e/sandbox_csp.cjs                 # needs a Chromium; SC_CHROME names it
```

## What comes next

1. The rest of `appHost`: the geometry ops, which need the engine reachable
   from a plugin, and the file ops, which need a way for a plugin to ask for a
   file rather than name one.
2. The wasm loader in the guest, which is what makes a Rust plugin run rather
   than merely compile.
3. Somewhere to press "run". A compute plugin is installable and runnable in
   code today and has no button.
4. MCP onto the broker, so it is a plugin in fact and not only in the
   Preferences list.
5. Panel plugins. Note that the policy currently forbids frames outright, and
   changing that is load-bearing for their sandbox rather than incidental.
6. OS sandboxing for process plugins, per platform.
7. Signing and revocation. Installing from anywhere is now possible, which
   makes "this build of this plugin is the one its author published" a question
   worth being able to answer, rather than a nicety.
