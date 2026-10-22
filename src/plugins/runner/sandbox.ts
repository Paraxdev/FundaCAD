// The only project code in a plugin's Worker. ./spawn.ts inlines the plugin as a function body after importing this, so
// no 'unsafe-eval' is needed. Escaping the wrapper gains a plugin nothing: the boundary is the Worker.

import { serveGuest, type PluginApp } from "./guest";
import { START, type Port } from "./protocol";

/** Called once by the generated script, with the plugin as a function. */
export function startPlugin(run: (app: PluginApp) => Promise<unknown>): void {
  // `self` in a Worker has postMessage and addEventListener, the whole of Port.
  serveGuest({ port: self as unknown as Port, run });
}

// A global, not an export: a worker entry has no importers, so Vite tree-shakes its exports away.
// tests/plugins/sandboxChunk.test.ts checks the build output.
(globalThis as unknown as Record<string, unknown>)[START] = startPlugin;
