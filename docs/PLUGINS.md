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

## The five plugins this project publishes

| id | what it is | asks for | kind |
| --- | --- | --- | --- |
| `FundaCAD.MCP` | lets an assistant build, measure and edit the open model | `document.*`, `geometry.build`, `files.*` | `process` |
| `FundaCAD.Printing` | printers on your network, and opening a model in a slicer | `document.read`, `files.write`, `printer.control`, `process.spawn` | `builtin` |
| `FundaCAD.SpaceMouse` | navigating and moving with a 3D mouse | `device.input`, `document.read`, `document.write` | `builtin` |
| `FundaCAD.MultiColor` | filament slots, per body and per texture colour | `document.read`, `document.write` | `builtin` |
| `FundaCAD.Texture` | a printed surface texture on picked faces or a whole body | `document.read`, `document.write`, `files.read` | `builtin` |

**THE APP SHIPS NONE OF THEM.** Every one is a zip on a release, installed like
anybody else's, and a fresh install runs nothing but the app. Three of them used
to be compiled in with a switch each, and the switch was the only control they
had because "installed" was not a question they had an answer to.

`builtin` still means something and it is worth being exact about what: the
plugin's code runs in the APPLICATION'S OWN JAVASCRIPT CONTEXT, with the
application's own reach. That is a fact about what it can do. It never was a
fact about where it came from, and the two came apart the moment these were
packaged.

Each is a directory under `plugins/`: `manifest.json`, a `README.md` saying why
it asks for what it asks for, and a `main.ts` if it has anything to run in the
window. The manifest in that directory is the one the app reads and the one the
zip carries. There is no second copy.

**Their ids were renamed** when the directories appeared: `printing`,
`spacemouse` and `multi-material` are what they were called. Each plugin lists
its own old names in its manifest, under `formerIds`, rather than the app
holding a rename table for plugins it does not otherwise know exist.

Some of the grant choices are worth stating, because the tempting answer is the
wrong one in each case. Each one lives in that plugin's own `README.md` now,
beside the manifest it explains, because JSON has no comments and the reasoning
is the half worth keeping:

- **Printing claims `process.spawn`.** Opening a model in a slicer starts
  another program on the machine, and that is the most consequential thing
  anything in this app does on the user's behalf.
- **Printing does not claim `network`.** It reaches printers configured in
  this app, over the local network. "Connect to the internet" would be a worse
  description rather than a more cautious one.
- **The 3D mouse claims `document.write`.** Its object mode moves the selected
  body, and a move is an edit. Omitting it because the edit arrives through a
  knob rather than a dialog would be describing the input device instead of the
  effect.
- **The 3D mouse does not claim `process.spawn`**, and neither does the MCP
  plugin. A vocabulary whose grants are claimed whenever they are technically
  defensible is one where every screen looks the same.

### Two controls, and they mean different things

**Installed or not** is the big one. A plugin that is not installed is not on
the machine: no code, no chunk, nothing to fetch. That is the state of every
plugin on a fresh install.

**Switched off** is the smaller one, and it applies to something already
installed: the bundle stays on disk, whatever it wrote to the document stays,
and it does not run. It is what somebody reaches for to find out whether a
plugin was the cause of something. `registry.ts` records only the exception —
which ids are OFF — because installing something is already an answer to "do
you want this".

Either way, off takes effect immediately: `activate()` returns a teardown, and
the frame loop, the event listeners, the menu rows, the overlays, the paint on
the model and the Rust-side device handle all go with it.

Two things keep this true, and they check different halves.
`tests/plugins/coreIndependence.test.ts` reads every file under `src/` and under
`plugins/` and fails if anything outside a capability's own directory statically
imports something inside it. `scripts/check-no-plugin-code.mjs` reads the BUILT
BUNDLE and fails if any marker of a plugin's code is in it, because what keeps
plugin code out of a shipped build is one `import.meta.env.DEV` branch in
`activate.ts` and nothing fails loudly if that branch is written a way rollup
cannot drop.

That test used to carry exceptions. The printer connection "owned" `src/print/`
and three components in `src/components/overlays/`; the 3D mouse owned
`src/input/spacemouse.ts` and a fourth component. It passed, and what it proved
was narrower than it sounded: nothing imported those files, but they were in the
app's own tree, typechecked with it, and one line from being coupled again. Each
capability is now a directory and each predicate is a path prefix, so there is
nowhere for an exception to hide.

Whatever a capability owns in the document survives being turned off. Slot
assignments are saved, loaded and exported exactly as before, so turning
multi-material back on finds the work still there. A toggle that ate data would
not be a toggle.

## How a downloaded plugin's code runs

A plugin that DRAWS — a menu row, a Vue component, paint on the model — runs in
the application's own JavaScript context. It has to: none of that is expressible
from a Worker or from a separate process. So there is no sandbox to put such a
plugin in, and pretending otherwise on the consent screen would be the worst of
both. What there is instead is an origin rule.

**Code loaded this way runs with the application's own reach. Therefore it is
loaded only from a bundle this project published.** `sandboxNote("builtin")`
tells the person exactly that, in the words they read on the screen where they
decide: "Part of FundaCAD itself. The list above is what it uses, not a limit on
it."

| | |
| --- | --- |
| `scripts/build-plugin-code.mjs` | builds a plugin directory into `main.js`, one IIFE taking one argument |
| `src/plugins/host.ts`, `hostUi.ts` | the whole of what a plugin may import: `fundacad` and `fundacad/ui` |
| `src/plugins/loader.ts` | evaluates that module against the running app's own vue, pinia, three and host |
| `src-tauri`'s `plugin_code` | the origin rule, enforced where the bytes are |

`vue`, `pinia`, `three`, `fundacad` and `fundacad/ui` are externalised by the
build and supplied by the loader. Not to save bytes: two copies of Vue is two
reactivity systems that cannot see each other's refs, two Pinias are two store
registries so one `defineStore` call returns two different stores, and two
three.js make `instanceof` false between them. Each fails at runtime, quietly,
looking like a bug in the plugin.

`new Function` rather than `import()`, because the policy is `script-src 'self'`
and a blob URL is not a script source. That makes plugin loading the SECOND
reason `'unsafe-eval'` is in the policy; `tests/security/csp.test.ts` names both
and reads this file as text to check the second, so the grant can never outlive
its reasons.

### What is not finished

`verify_plugin_signature` fails closed the moment a public key exists, and there
is no key. Until there is one, the anchor is GitHub's TLS and this repository's
path — which is the same anchor the updater has before ITS signature check.
Generating a key pair has a custody consequence and is not a decision to take on
somebody's behalf.

## What the app lets a plugin add

A capability that only had a switch would be a capability that could not do
anything. Three of them needed to put things on screen, and for a long time the
app did it for them: `App.vue` mounted a camera panel and a filament dialog by
name, `app/menubarDef.ts` wrote out the 3D mouse's menu behind a capability
check and cached the input module so it could tick the right mode,
`ui/ribbonDefs.ts` held a PRINT group plus a list of which of its buttons to
remove again, `app/actions.ts` had three print cases, `stores/dialogs.ts` and
`stores/panels.ts` each carried a field for somebody else's window, and the
browser panel carried a filament palette with a LAN probe and a thirty-second
staleness poll in it. Every one of those was the app knowing what a capability
IS, and every one was an edit a fourth capability would have needed.

`src/plugins/contrib.ts` is what replaced them. A plugin calls `contribute` once,
with everything it adds, and gets back the removal:

| point | what it fills |
| --- | --- |
| `menus` | rows in a menu that exists, or a whole menu that does not |
| `ribbon` | a group of buttons, with a collapse priority |
| `actions` | action ids, reached from the ribbon, the palette, the keymap and every context menu |
| `overlays` | components mounted for the life of the capability |
| `browserSections` | a panel in the browser, drawn as its own component |
| `bodyMenu` | rows on a body's right-click menu |
| `paint` | colours for bodies and faces, asked for fresh at every rebuild |
| `palette` | the colours a tool may offer |
| `importedBody` | an imported mesh carried a colour of its own |
| `provides` | a value offered to OTHER plugins, by name |
| `tools` | a modeling tool: what it consumes, and whether it is running |
| `features` | how a feature type is drawn and edited |
| `icons` | a mark for a verb the app does not have |

Four things this deliberately is not. There is no generic "run this on event X".
There is no way to replace a core behaviour: `app/actions.ts` reaches its own
`switch` before it asks the table, so a contribution naming `save` is inert, and
that is the order of the code rather than a check that could be forgotten. There
is no way to read another plugin's contributions except `service()`, which hands
back an opaque value the app never looks inside — the same arrangement as grant
strings, which Rust compares without knowing what one means. And the table names
no plugin, anywhere.

**The signal is the contribution, not the switch.** These are different moments:
a capability is switched on, and some milliseconds later its module is fetched
and its `activate()` runs. A surface that redraws on the switch redraws while the
rows it wants are still loading and is then left showing the previous state
permanently, because nothing else is coming. `TitleBar.vue` and `RibbonBar.vue`
watch `onContribChange` for exactly this reason. It is written down because it
was got wrong, and because no unit test caught it — a rendered app did.

### A modeling tool, which is what the last three points are for

The first ten points came out of capabilities that add to the EDGES of the
window: a panel, a settings block, a menu row, colours on a body. Surface Texture
was a different question, and it is the one that says whether any of this works,
because a tool is a peer of Fillet and Press/Pull rather than an addition to
them. Twenty-three files under `src/` named it, from the engine that constructed
it to the dispatcher that ran it to the properties panel that decided its Seed
row was worth drawing.

Most of what it needed already existed. The ribbon button went through `ribbon`,
the action behind it through `actions`, the docked panel through `overlays`.
Three things did not:

`tools` is the capability row: what the tool acts on, and whether it is running.
Both halves earn their place. Without the first, a contributed tool has a ribbon
button and nothing else — selecting a face offers Fillet, Press/Pull and Delete
Face and stays silent about the tool that is the whole reason a face is selected.
Without the second, `app/toolBusy.ts` believes the window is idle while a plugin
owns the pick, so it dispatches a second tool over the top of the first and the
user has two prompts and one Escape key.

`features` is how the feature the tool leaves behind is DRAWN and EDITED: its
mark and its name in the history, its dropdowns and its switch, which of its
value rows a given pattern actually reads, what its shape slider is called, and
what a double-click on it does. One point rather than five, because they are all
the same sentence and five would be five things to remember, four of which fail
silently.

`icons` is a mark for a verb the app does not have. It is resolved AFTER both
icon packs, so a pack the user chose keeps the last word: a plugin fills a name
no pack has, and nothing else. This markup reaches the DOM through `Icon.vue`,
which is the one sanctioned `v-html` in the app, and it is safe on the same terms
core markup is — every value is a compile-time constant in a bundle whose code
already runs with the whole of the app's reach.

### The line a plugin may not cross

**A plugin owns how something is CREATED and PRESENTED. It does not own whether a
file you already saved still opens.**

So `texture` stays in the `Feature` union in `src/types.ts`, the geometry that
builds it stays in the sidecar, and `document/numFields.ts` keeps its numeric
rows — that table is not a list of labels, it is the inventory of what a
PARAMETER can drive, and `resolveTarget` reads it to answer what `texture1.depth`
refers to. A parameter has to keep meaning the same thing on a machine where the
plugin is switched off.

With the plugin gone, a document with a texture in it opens, rebuilds, renders
and exports; its numbers stay editable and stay parameter-drivable; and its row
in the history falls back to a grey dot and the raw type, which is honest,
because that is exactly what it is to that build. What you lose is the panel that
makes one. `e2e/texture_plugin.cjs` ends by switching the plugin off and
rebuilding the document, because this is the claim most worth checking against a
running app rather than against a test that could be measuring its own fake.

### Two plugins that need each other

The filament palette is the case that made this concrete. A palette is a list of
colours in a document, which belongs to the colour capability; "what is actually
loaded in toolhead 3 right now" can only be answered by something that can reach
the machine. Neither can draw that panel alone, and neither should import the
other.

So the panel belongs to the capability that owns the data, and the printer
contributes the answer under a name the two of them agree on (`filaments`),
through the app, which stores it and hands it back without looking inside. With
the printer switched off the panel is not hidden by a check: it has no way to
learn what is loaded, so it draws nothing — which is what it should do on a
machine with no printer anyway.

## Where a plugin's source lives

**A plugin is a directory under `plugins/` with a `manifest.json` in it.** That
is the entire rule. Adding a plugin is adding a directory: no script, workflow
or list is edited, and a directory without a manifest is skipped rather than
packaged into something that cannot be installed.

```
plugins/
  FundaCAD.MCP/            manifest.json, README.md, server.py and the rest
  FundaCAD.MultiColor/     manifest.json, README.md, main.ts, palette.ts,
                           PaletteSection.vue
  FundaCAD.Printing/       manifest.json, README.md, main.ts, printerClient.ts,
                           printFlow.ts, printDialog.ts, printStatusLine.ts,
                           printStatus.ts, exportProject.ts, state.ts,
                           PrintStatusPill.vue, CameraPanel.vue,
                           FilamentMappingDialog.vue, FilamentMappingHost.vue
  FundaCAD.SpaceMouse/     manifest.json, README.md, main.ts, spacemouse.ts,
                           state.ts, SettingsHost.vue, SpaceMouseModal.vue
```

A capability's Vue components live there too, and that is the point rather than
an oddity: a settings window that only one capability opens is that
capability's, wherever the rest of the app happens to keep its components.

`plugins/` is a plugin's OWN source. `src/plugins/` is the app's side of the
arrangement: the vocabulary, the broker, the runner, the registry and the
screen. The two are not the same thing and are not in the same place.

### Ids are `Publisher.Name`

An id is a global name in a space anybody may publish into. Without a publisher
segment the first two people to write an exporter both call it `exporter`, and
the second installs over the first.

It is also a **directory name**, which is what the rest of the rule is about.
Every segment must start with an ASCII letter, so `.`, `..`, `.ssh` and
`.staging-x` cannot be spelled at all. That is not defence in depth, it is the
defence: an id is joined onto the plugins root in Rust, so `safe_id` in
`src-tauri/src/plugins/bundle.rs` is a path guard wearing the word "id", and
`ID` in `src/plugins/manifest.ts` is the same rule on this side.

Two ids differing only in case are treated as **one plugin**, by `sameId()`.
Windows and macOS would give `Someone.Tool` and `someone.tool` the same
directory and Linux would give them two, so without that rule an install
replaces somebody else's plugin on one machine and sits beside it on another.
Equal everywhere is the strict reading and the only one safe to standardise on.

### One manifest, three readers

The manifest in the directory is the only copy. Three programs read it:

| | |
| --- | --- |
| the app | `src/plugins/shipped.ts` globs `plugins/*/manifest.json` at build time |
| the packager | `scripts/build-plugins.py` reads it to decide what to zip |
| the installer | reads the packaged copy back out of the zip and checks it against what the user agreed to |

It used to be two copies: a JSON literal in `registry.ts` or `index.ts`, and the
plugin's own file for the bundle to carry. Two copies of a permission list is
two lists that can disagree, and the copy that would have won an argument is the
one the consent screen never showed. `tests/plugins/offered.test.ts` now asserts
that the offered entry and the file on disk are the same value, with a control
that the comparison can still fail.

**A `builtin` is never packaged.** Its code is the app's own code; there is no
zip for it to arrive in and nothing that could install one. The packager skips
it, and `officialPlugins()` leaves it out, because offering to download one
would be offering a 404 behind a consent screen somebody has just answered.

The packager refuses anything else that could not work once installed: a
manifest whose `id` disagrees with the directory name, an id that is not a
usable id, an unknown kind, or a missing entry point for the kind it claims. A
bundle missing its entry point installs perfectly and then does nothing, which
is the most annoying shape a failure can have.

### Two things that broke on the way here

**A shipped plugin's TypeScript is still the app's TypeScript, and moving it out
of `src/` moved it out of the typechecker.** `tsconfig.json` included
`src/**/*.ts`, so `plugins/*/main.ts` compiled into the bundle with nobody
checking its types. It was found by putting a deliberate type error in one and
getting no output at all. `plugins/**/*.ts` is in `include` now.

**Nothing should work out where the repository root is by counting directories
up from itself.** `sidecar_link.py` did, with two `dirname` calls that meant "the
checkout" only while the plugin sat one level down. It searches upward for a
`sidecar/server.py` now, so the directory could be renamed under it without
every geometry test failing at once, and it finds nothing when installed under
the app data directory, which is exactly when the environment override is
supposed to take over.

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
4. Read the bundle's own `manifest.json` and compare kind, grants and hosts
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

`tests/plugins/broker.test.ts` reads the op list out of `plugins/FundaCAD.MCP/server.py` rather
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
app assigns them (checked against `plugins/FundaCAD.MCP/model.py`, so the two cannot drift), a
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

## Reaching past the window

Four ops go somewhere the webview cannot: `file_pick`, `file_read`, `file_write`
and `app_info`. They are on the **same op table**, checked by the **same
broker**, against the **same grants** as everything else, and that is the whole
design decision. The tempting shape is a second channel, a `native` object
handed to the plugin beside `app`, and a second channel is a second permission
system to keep in step with the first. There is one door.

### A plugin never names a file

It asks. A native dialog opens, with the plugin's id and its own sentence in the
title, and if the person chooses something what comes back is a **handle**: an
opaque token, a file **name**, and a length.

```js
const picked = await app.call("file_pick", {
  purpose: "choose a profile to trace",
  extensions: ["svg"],
});
if (!picked) return "nothing chosen";          // they dismissed it
const body = await app.callOrThrow("file_read", { handle: picked.handle });
```

So "which files may this plugin read" needs no rule, no configured directory and
no sandbox root to get wrong. It is: **the ones somebody picked, this session,
for this plugin.** A plugin cannot name a file, cannot guess a handle (they are
random), and cannot use another plugin's handle, because every handle records
whose it is and the check runs on every read.

A path never crosses — not to the plugin, and not even into the window. The
handle table lives in Rust, in `src-tauri/src/plugins/handed.rs`, so the most a
plugin can learn about somebody's disk is a file name they chose to show it. A
plugin that could display `C:\Users\alice\Documents\work\part.step` has been
told the person's name and the shape of their disk in exchange for nothing it
needed.

`file_write` has no handle at all and never will: the person picks the path
every time, which is the difference between "save this file" and "may I write to
your disk".

### A dismissed dialog is an answer, not an error

`file_pick` and `file_write` return `null` when the dialog is dismissed. A
plugin that treats that as a failure will show somebody an error for having
changed their mind, so the test double takes `answers: { file_pick: null }`
precisely so that branch is reachable in a plugin's own tests. It is the one
every author forgets.

### Why `doc_open` and `doc_save` still refuse

Not because they are unfinished. Both take a **path**, which is the one thing a
plugin may not have, so they will keep refusing and their refusals name what to
do instead:

| instead of | a plugin does |
| --- | --- |
| `doc_open` | `file_pick`, then `file_read`, then `doc_set` |
| `doc_save` | `doc_get`, then `file_write` |

The alternative was to give those two ops a different meaning for a compute
plugin than they have over MCP, where the server is a process on the machine and
can open a file by naming it. One vocabulary that means two things is worse than
one vocabulary with a gap in it.

### What is enforced where

| | |
| --- | --- |
| may this plugin ask at all | the broker, against the grants recorded at install |
| may the app do this yet | the host, by name, per op |
| is the desktop app under it | the host again, and it says so separately |
| whose file is this | Rust, on every read |
| does this happen at all | the person, at a native dialog, every time |

Three refusals rather than one is deliberate. "You did not ask for this", "the
app cannot do this yet" and "this is not running in the desktop app" are
different problems with different fixes, and one message that could mean any of
them is worth much less than three that cannot.

The Rust side knows nothing about `files.read` and must not learn, for the same
reason the installer next door knows nothing about `document.write`.

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
more than one id scheme here: `plugins/FundaCAD.MCP/model.py` names features by type
(`bx1`, `ex1`) and the app names them `f1`, `f2`, counting from what it already
has. Both are hosts for one op vocabulary and both are right. The lesson holds
either way: **read the id `feature_add` returns, never predict it.**

### What appHost does not serve yet

`build`, `inspect`, `view` and `export` need the geometry engine, which a plugin
cannot reach yet. `doc_open` and `doc_save` refuse permanently and for a
different reason; see above. Each refuses by name.

`file_pick`, `file_read`, `file_write` and `app_info` are served, but only when
the host was given a `NativeBridge` and a plugin id. In a browser session or a
test that passed neither, they refuse with a message naming which half is
missing rather than pretending to have opened a dialog nobody saw.

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
| `src/plugins/broker/native.ts` | the four ops that reach past the window, and the bridge to Rust |
| `src/plugins/broker/testing.ts` | the app a plugin's tests are handed |
| `src/plugins/runner/*.ts` | the sandbox: protocol, host, guest, spawn |
| `src/plugins/shipped.ts` | the one glob of `plugins/*/manifest.json`, parsed |
| `src/plugins/contrib.ts` | what a plugin may add to the app, and the only way in; names no plugin |
| `src/plugins/registry.ts` | which installed plugins are switched off; names no plugin either |
| `src/plugins/host.ts` | `fundacad`: the whole of what a plugin may import |
| `src/plugins/hostUi.ts` | `fundacad/ui`: the four components, kept apart so `fundacad` needs no DOM |
| `src/plugins/loader.ts` | evaluates a downloaded plugin's module against the app's own modules |
| `src/plugins/devPlugins.ts` | the plugin directories, in a DEV build only |
| `scripts/build-plugin-code.mjs` | builds one plugin directory into the module its bundle carries |
| `scripts/check-no-plugin-code.mjs` | reads the built bundle and fails if any plugin's code is in it |
| `src/plugins/activate.ts` | starting and stopping them, by dynamic import; names none of them |
| `src/plugins/index.ts` | the plugins this build offers, and the bridge to Rust |
| `src/components/overlays/PluginsSection.vue` | Preferences ▸ Plugins |
| `src-tauri/src/plugins/mod.rs` | the commands: list, inspect, install, remove, python runtime |
| `src-tauri/src/plugins/bundle.rs` | the refusals, split out so they can be tested |
| `src-tauri/src/plugins/files.rs` | the dialogs and the disk |
| `src-tauri/src/plugins/handed.rs` | which files a plugin holds, split out so it can be tested |
| `plugins/<id>/manifest.json` | what it is and what it asks for; the only copy |
| `plugins/<id>/README.md` | why it asks for that |
| `plugins/<id>/main.ts` | a shipped capability's activation module: everything it contributes |
| `plugins/<id>/*.vue` | a capability's own components, mounted through `overlays` or `browserSections` |
| `plugins/<id>/server.py` | a process plugin's entry point |
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
node scripts/check-no-plugin-code.mjs    # reads the same build
python scripts/build-plugins.py <dir>    # builds all four bundles, needs node
node e2e/sandbox_csp.cjs                 # needs a Chromium; SC_CHROME names it
node e2e/plugin_surfaces.cjs             # needs `npx vite` on 5173 as well
```

`e2e/plugin_surfaces.cjs` is the one that starts the real app, lets the real
loader find the real plugin directories, and then switches each capability off
and on while reading the menubar and the ribbon back out of the DOM. It exists
because the async-arrival bug above was invisible to every unit test in this
repository and obvious within one run of it.

## Battle-testing this, and what it found

Surface Texture was moved out specifically to find out whether the contribution
table was real or whether it merely fitted the four capabilities it had been
written against. What the move cost, measured rather than asserted:

| | |
| --- | --- |
| new contribution points | three |
| core files that stopped naming a texture | twenty-three |
| main chunk | 4,183.29 kB -> 4,150.99 kB (932.01 -> 925.49 gzipped) |
| tests | 2,028 -> 2,118 |

The bundle got smaller, which is the arithmetic working the right way round: the
tool, its panel and its form logic left the app, and nothing was added to replace
them but three readers of a table that was already there.

Where the checks are:

| | |
| --- | --- |
| `tests/plugins/contribTools.test.ts` | the three points at the table: order, collisions, and that everything goes away with the plugin |
| `tests/features/toolCapabilities.test.ts` | the rules, pure over a table the test wrote; then the merge, precedence and lifetime |
| `tests/ui/contributedIcons.test.ts` | resolution order, and that a pack the user chose beats a plugin |
| `tests/ui/featureMeta.test.ts` | every type in the document format is drawn by the app or by a named plugin |
| `tests/plugins/textureTool.spec.ts` | the gesture, against a viewport and a store the test controls |
| `tests/plugins/texturePlugin.spec.ts` | the real `activate()`, then every surface asked twice: once running, once switched off |
| `tests/plugins/coreIndependence.test.ts` | nothing under `src/` statically imports the plugin |
| `e2e/texture_plugin.cjs` | all of it in a real window, ending with the plugin off and the document still building |
| `tests/viewport/streamedSelection.test.ts` | the two rules a stream adds to carrying a selection (see below) |

Two things this found that a smaller move would not have:

**`FEATURE_META` could not stay a total `Record`.** It was one, so a new feature
type with no mark was a compile error. The union is the document FORMAT, which is
a wider thing than what a build knows how to draw, and the two came apart the
moment a tool became a plugin. The check moved to `tests/ui/featureMeta.test.ts`
and got stricter on the way: every type in the union has to resolve to a mark
from the app or from a named plugin, which holds the plugins to it too.

**`fieldApplies` was a document-layer function whose entire body was one tool's
business.** It opened with `if (type !== "texture") return true;`. It is a
contribution now, and it still governs the app's own numeric rows — which is the
better arrangement, not a concession: the app owns `seed` and `angle` because a
parameter can drive them, and the plugin decides which of them a knurl reads.

### And then driving it found a bug in the application

The move above is a refactor: it says the tool can live outside `src/`, not that
the tool works. Actually using it — a browser, the real sidecar, eight shapes and
every pattern, twenty-eight gestures — said something else. **Ten of the
twenty-eight worked.** The rest picked a face, showed it selected, and then
refused Add with "No faces selected" over a face that was lit up on screen. Same
shape, different answer run to run, which is what "sometimes" always means.

It was not the plugin, and it was not the geometry: the same sweep straight at
the kernel displaced correctly on sixty of sixty-six shape/pattern pairs, and the
six were the harness's own bad input. It was `viewport.ts`.

**A rebuild used to reach the screen in one piece, and it does not any more.**
`setModel` was taught to carry the selection across a rebuild — capture before
the Highlighter goes, restore onto the new model, `selectionMemo.ts`. A chunked
reply reaches the screen in several installments instead, and every one of them
publishes a fresh ModelView with a fresh Highlighter. Nothing carried the
selection across those. So it was gone before the commit ran, and the commit's
own capture, reading that emptied Highlighter, correctly answered "nothing is
selected" and restored nothing. Whether a reply streams at all depends on how big
it is, which is the whole of the intermittency.

Traced rather than guessed at, by sampling the selection every 60 ms through the
gesture. The selection died mid-build, before `setModel` was called at all:

```
172ms onBuild building=true  sel=1
183ms onBuild building=true  sel=1
189ms onBuild building=true  sel=0   <- gone, and nothing had called setModel yet
213ms setModel               sel 0->0
```

**This was never a texture bug.** With no plugin loaded and no tool running, an
ordinary two-face selection was lost across an ordinary rebuild in four runs out
of four, and kept in four out of four once the stream carried it. Every
selection-driven gesture in the app was standing on this. Texture is simply the
one that could not hide it: for a fillet the selection arms a drag handle, and a
handle that flickers is a cosmetic complaint, whereas here MEMBERSHIP IS THE
SELECTION, so losing it silently is losing the gesture.

The fix is in the shared path, so it is not a plugin's:

| | |
| --- | --- |
| `viewport.ts` `streamMemo` | snapshot at `begin`, re-applied on every installment, and the commit's fallback |
| `selectionMemo.ts` `remapStreamedSelection` | a body whose chunk has not landed is not a body whose face is gone: hold the geometric fallback back rather than let it match some other body's face |
| `selectionMemo.ts` `shouldAnnounce` | a commit announces a lost selection, an installment does not — mid-stream "nothing came back" is not news, and announcing it takes the drag handle down a few milliseconds before the body lands |

Two things the plugin kept for itself, because they are about a gesture rather
than about drawing. Its rAF tick ignores the ambient selection entirely while a
rebuild is in flight, since mid-rebuild it is unknown rather than new. And a
commit pressed during a rebuild is HELD and run when the build lands, instead of
being refused — the person has finished and is waiting, and "nothing is selected"
was a lie told to them about a face they could see.

Measured the same way it was found: **twenty-eight of twenty-eight**.

And one more thing the sweep turned up, latent rather than active:
`tessellate.py` wrapped `displace_face` in a bare `except Exception: pass`. A
texture that threw was not an error, not a diagnostic and not a red timeline row
— it was a face that came out flat under a feature the timeline said was fine,
with nothing anywhere to tell that from a pattern that legitimately does nothing
there. It still falls back rather than failing the build, and now it says so.

## What comes next

1. **The geometry engine, reachable from a plugin.** `build`, `inspect`, `view`
   and `export` are the four ops still refusing for a reason that will go away.
   The file half of `export` is already answered — `doc_get` then `file_write` —
   so what is left is the kernel call itself.
2. The wasm loader in the guest, which is what makes a Rust plugin run rather
   than merely compile.
3. Somewhere to press "run". A compute plugin is installable and runnable in
   code today and has no button.
4. MCP onto the broker, so it is a plugin in fact and not only in the
   Preferences list.
5. Panel plugins. Note that the policy currently forbids frames outright, and
   changing that is load-bearing for their sandbox rather than incidental.
6. OS sandboxing for process plugins, per platform.
7. **Signing.** The one that moved up the list. App-side code is loaded only
   from this project's own releases, and until there is a key that rule anchors
   on GitHub's TLS and this repository's path alone.
   `verify_plugin_signature` fails closed the moment a public key exists, so
   the remaining work is generating the pair and signing the bundles in the
   release job. Generating it has a key-custody consequence and is not a
   decision to take on somebody's behalf.
8. Revocation, once there is something to revoke.
