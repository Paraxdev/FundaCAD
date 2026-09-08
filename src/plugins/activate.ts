// Starting and stopping the built-in capabilities.
//
// One place where the core says "run whatever is turned on" instead of naming
// the things it runs. That sentence is the whole point of this file: after it,
// nothing in app/ imports the 3D mouse or the printer, and adding a fourth
// capability is adding a directory under plugins/ rather than an edit to
// anything here. This file names no capability at all.
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
 *  A capability with nothing to START simply has no `main.ts`, and needs no
 *  entry here to say so. FundaCAD.MultiColor is the one: it has no listeners,
 *  no device and no process, only gates read where the work happens (the
 *  document store, the browser tree, the exporters), so there is nothing to
 *  hand a teardown for. Its manifest is still what those gates read. */
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
export function activateBuiltins(e: Engine): () => void {
  const running = new Map<string, () => void>();
  // An activation is asynchronous, so a fast off-on-off can otherwise land its
  // teardown before the thing it tears down exists. Recording the intent and
  // checking it again on the far side of the await is what keeps the last
  // instruction the winning one.
  const wanted = new Set<string>();

  const sync = () => {
    for (const id of Object.keys(LOADERS)) {
      const on = pluginEnabled(id);
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
  const off = onPluginChange(sync);
  return () => {
    off();
    wanted.clear();
    for (const stop of running.values()) stop();
    running.clear();
  };
}
