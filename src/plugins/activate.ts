// Starting and stopping the plugins that ship in this repository.
//
// One place where the core says "run whatever is active" instead of naming the
// things it runs. That sentence is the whole point of this file: after it,
// nothing in app/ imports the 3D mouse or the printer, and adding a capability
// is adding a directory under plugins/ rather than an edit to anything here.
// This file names no plugin at all.
//
// ACTIVE MEANS TWO DIFFERENT THINGS, and both are here. A built-in is active
// when its switch is on. A BUNDLE is active when it is installed on disk — and
// a bundle can have an app-side module too: a process plugin still has a face
// in the app (a setting that governs it, a badge that says who is connected),
// and that face has to appear and disappear with the install rather than being
// written into the app on every machine whether anybody installed it or not.
//
// The imports are dynamic, and that is load-bearing rather than tidy: see
// MAIN below. "Not part of the core" ends up a fact about the build rather than
// a claim in a comment.
//
// Turning one off at runtime really does stop it. Each activate() returns its
// teardown, and this holds them so a toggle can run the right one. A capability
// that could only be switched off by restarting would be a checkbox that lies
// for as long as the session lasts.

import { onPluginChange, pluginEnabled } from "./registry";
import { installedIds, onInstalledChange, refreshInstalled } from "./index";
import { shippedPlugins } from "./shipped";
import type { Engine } from "../app/engine";

/** Whatever a capability needs to do when it starts, and the undo for it. */
type Activator = (e: Engine) => Promise<() => void>;

/** Every plugin directory that has a `main.ts`, as a loader that has not run.
 *
 *  NOT eager, and that is the load-bearing half. A static import would put the
 *  printer client, the slicer bridge, the HID event plumbing and the input
 *  filter into the bundle every machine downloads and parses at startup,
 *  whether or not that machine has a printer or a 3D mouse. Written this way
 *  the bundler gives each capability a chunk of its own, and a capability that
 *  is off is never fetched.
 *
 *  A plugin with nothing to start in the app simply has no `main.ts`, and needs
 *  no entry here to say so. */
const MAIN = import.meta.glob("../../plugins/*/main.ts") as Record<
  string,
  () => Promise<unknown>
>;

/** `../../plugins/Some.Thing/main.ts` -> `Some.Thing`. */
function idOf(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 2] ?? "";
}

const LOADERS: Record<string, () => Promise<unknown>> = Object.fromEntries(
  Object.entries(MAIN).map(([path, load]) => [idOf(path), load]),
);

/** Which plugins are built into the app, as their own manifests declare.
 *
 *  Read once: the set of directories in this repository is fixed at build time.
 *  It decides only WHICH QUESTION to ask about a plugin — "is its switch on" or
 *  "is it installed" — and never whether the answer is yes. */
const IS_BUILTIN = new Set(
  shippedPlugins().filter((p) => p.manifest.kind === "builtin").map((p) => p.dir),
);

/** Whether this plugin's app-side module should be running.
 *
 *  A bundle whose id is not installed is not active, including the ones whose
 *  source happens to live in this repository: shipping a plugin's source is not
 *  the same as somebody having it. */
function active(id: string): boolean {
  return IS_BUILTIN.has(id) ? pluginEnabled(id) : installedIds().has(id);
}

/** A module is startable if it exported the one thing this file calls.
 *
 *  Checked rather than asserted, because the glob above will happily pick up a
 *  `main.ts` that exports something else entirely, and the failure would
 *  otherwise be `m.activate is not a function` at a point where nothing says
 *  which plugin. */
function activatorOf(m: unknown): Activator | null {
  const fn = (m as { activate?: unknown } | null)?.activate;
  return typeof fn === "function" ? (fn as Activator) : null;
}

/** Run the capabilities that are on, and keep doing so as that set changes.
 *
 *  Returns a teardown that stops everything and stops listening, which is what
 *  a test needs to leave no timers, listeners or device handles behind. */
export function activatePlugins(e: Engine): () => void {
  const running = new Map<string, () => void>();
  // An activation is asynchronous, so a fast off-on-off can otherwise land its
  // teardown before the thing it tears down exists. Recording the intent and
  // checking it again on the far side of the await is what keeps the last
  // instruction the winning one.
  const wanted = new Set<string>();

  const sync = () => {
    for (const id of Object.keys(LOADERS)) {
      const on = active(id);
      if (on && !wanted.has(id)) {
        wanted.add(id);
        void LOADERS[id]!()
          .then((m) => {
            const activate = activatorOf(m);
            if (!activate) {
              throw new Error(`plugins/${id}/main.ts exports no activate()`);
            }
            return activate(e);
          })
          .then((stop) => {
            if (!wanted.has(id)) {
              stop(); // turned off again while it was loading
              return;
            }
            running.set(id, stop);
          })
          .catch((err) => {
            wanted.delete(id);
            // Loud, but not fatal. A capability that will not start is a
            // feature missing from the window, and a window that will not open
            // is worse. The console is where the reason has to be.
            console.error(`[plugins] ${id} could not start:`, err);
          });
      } else if (!on && wanted.has(id)) {
        wanted.delete(id);
        running.get(id)?.();
        running.delete(id);
      }
    }
  };

  sync();
  const offSwitch = onPluginChange(sync);
  const offInstalled = onInstalledChange(sync);
  // What is on disk is not known until it has been asked for, and asking is a
  // command round-trip. Kicked off here rather than at a call site, so nothing
  // has to remember that starting the plugins needs this first.
  void refreshInstalled();
  return () => {
    offSwitch();
    offInstalled();
    wanted.clear();
    for (const stop of running.values()) stop();
    running.clear();
  };
}
