# Plugins

Optional pieces of the app, downloaded on demand, each one holding a permission
it declared before anyone agreed to install it. Preferences ▸ Plugins is the
whole user-facing surface.

The first one is the MCP server (`docs/MCP.md`), which was already a separate
process talking a defined protocol. It just was not called a plugin yet.

## The promise

One sentence, and everything else here is machinery for keeping it:

> **The promise made at install is the promise enforced, and a change to the
> promise is a change you see.**

A plugin declares what it wants to reach. That declaration IS the install
screen. A bundle that arrives asking for more than the screen said is refused
and deleted, at the point where it would otherwise have been unpacked into
place.

## What a plugin is

Three kinds, differing only in where the code runs. They share one permission
vocabulary.

| kind | where it runs | sandboxed by |
| --- | --- | --- |
| `process` | its own OS process, stdio | *nothing yet, and the install screen says so* |
| `panel` | an opaque-origin iframe, `default-src 'none'` | the browser |
| `compute` | a Worker with no fetch, no DOM | the browser |

Only `process` exists today, because MCP is one.

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
