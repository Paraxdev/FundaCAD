// Starting and stopping the built-in capabilities.
//
// One place where the core says "run whatever is turned on" instead of naming
// the things it runs. That sentence is the whole point of this file: after it,
// nothing in app/ imports the 3D mouse or the printer, and adding a fourth
// capability is a row in the table below rather than an edit to the engine.
//
// The imports are dynamic, and that is load-bearing rather than tidy. A static
// import would put the printer client, the slicer bridge, the HID event
// plumbing and the input filter into the bundle every machine downloads and
// parses at startup, whether or not that machine has a printer or a 3D mouse.
// Written this way the bundler gives each capability a chunk of its own, and a
// capability that is off is never fetched. "Not part of the core" is then a
// fact about the build rather than a claim in a comment.
//
// Turning one off at runtime really does stop it. Each activate() returns its
// teardown, and this holds them so a toggle can run the right one. A capability
// that could only be switched off by restarting would be a checkbox that lies
// for as long as the session lasts.

import { onPluginChange, pluginEnabled, type BuiltinId } from "./registry";
import type { Engine } from "../app/engine";

/** Whatever a capability needs to do when it starts, and the undo for it. */
type Activator = (e: Engine) => Promise<() => void>;

/** Only capabilities with something to START are here. `multi-material` is
 *  absent on purpose: it has no listeners, no device and no process, only gates
 *  read where the work happens (the document store, the browser tree, the
 *  exporters), so there is nothing to hand a teardown for. Its entry in the
 *  registry is still what those gates read. */
const LOADERS: Partial<Record<BuiltinId, () => Promise<{ activate: Activator }>>> = {
  spacemouse: () => import("./builtin/spacemouse"),
  printing: () => import("./builtin/printing"),
};

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
    for (const id of Object.keys(LOADERS) as BuiltinId[]) {
      const on = pluginEnabled(id);
      if (on && !wanted.has(id)) {
        wanted.add(id);
        void LOADERS[id]!()
          .then((m) => m.activate(e))
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
