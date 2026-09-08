// The module a plugin's Worker imports. This file IS the sandbox's own code,
// and it is the only code in that Worker that this project wrote.
//
// It is deliberately tiny. Everything it does is in ./guest.ts, which is
// testable without a Worker; what is left here is the two lines that cannot be:
// naming the Worker's global as the port, and being importable from a blob.
//
// HOW A PLUGIN GETS IN. ./spawn.ts builds a small script, makes a blob of it,
// and starts a Worker on that blob. The script imports this module for its
// SIDE EFFECT and then calls what it registered, with the plugin's own text
// inlined as a function body:
//
//     import "<this module>";
//     self[START](async function (app) {
//       ...the plugin...
//     });
//
// A global rather than a named export, and not by preference. Vite builds this
// file as a worker entry, and a worker entry has no importers, so anything
// reachable only through an `export` is tree-shaken out: the first build of
// this produced a chunk with the OPS array in it and no `startPlugin` at all,
// which would have failed at the blob's very first line. A top-level assignment
// to `self` is a side effect the bundler must keep. The build output is checked
// by tests/plugins/sandboxChunk.test.ts rather than trusted.
//
// So the plugin's code is the Worker's own script rather than a string handed
// to the Function constructor, and the sandbox needs no `'unsafe-eval'`. That
// matters beyond tidiness: `'unsafe-eval'` is in this app's policy for one
// reason (see tests/security/csp.test.ts) and is meant to be removed when that
// reason goes. A plugin system that quietly depended on it would make that
// removal impossible and nobody would find out until they tried.
//
// WHAT THE INLINING DOES NOT RISK. The plugin's text is concatenated into a
// script, so it can close the function early and run at the Worker's top level.
// That gains it nothing. Top-level Worker code has exactly the privileges the
// function body has: no DOM, no app, and one port whose other end checks every
// request against the grants. The boundary is the Worker, not the wrapper.

import { serveGuest, type PluginApp } from "./guest";
import { START, type Port } from "./protocol";

/** Called by the generated script, once, with the plugin as a function. */
export function startPlugin(run: (app: PluginApp) => Promise<unknown>): void {
  // `self` in a Worker has postMessage and addEventListener, which is the whole
  // of what Port asks for.
  serveGuest({ port: self as unknown as Port, run });
}

// The side effect the blob depends on, and the only reason this module has a
// top-level statement at all. Unconditional: nothing on the main thread imports
// this file, which is what `START` living in ./protocol.ts is for.
(globalThis as unknown as Record<string, unknown>)[START] = startPlugin;
