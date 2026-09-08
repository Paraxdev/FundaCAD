// Starting a real Worker for a real plugin. The one file here that only works
// in a browser, kept small for exactly that reason.
//
// THE SHAPE, and why it is this one rather than the obvious one.
//
// The obvious one is a static Worker that receives the plugin's text and hands
// it to the Function constructor. It works, and it would tie every compute
// plugin to `'unsafe-eval'` in the app's content-security policy. That grant
// exists for one unrelated reason and is meant to be removed when that reason
// goes (tests/security/csp.test.ts is what will say so); a plugin system
// quietly depending on it would make the removal impossible.
//
// So instead the plugin's text is inlined into the Worker's own script, which
// is a blob, and the blob imports ./sandbox.ts from the app's own origin. That
// needs `worker-src 'self' blob:` and nothing else. Measured rather than
// assumed, in a real browser under the policy this app ships: with `blob:` in
// `worker-src` and no `'unsafe-eval'` anywhere, the blob module worker starts,
// imports a same-origin module, and compiles WebAssembly. e2e/sandbox_csp.cjs
// is that measurement, kept.
//
// `worker-src` is a separate directive from `script-src`, which is the whole
// point of using it: the window itself gains nothing. A blob cannot become a
// script in the page, only a worker.

import { runInSandbox, type RunOptions, type RunOutcome } from "./host";
import { START, type Port } from "./protocol";

// Vite compiles this to a real ES-module chunk and gives back its URL. It is
// the ONLY thing the blob is allowed to import, and it comes from the app's own
// origin, which is what `worker-src 'self'` covers.
import sandboxUrl from "./sandbox?worker&url";

/** The script the Worker runs.
 *
 *  The plugin goes in as a function body. It is untrusted text being
 *  concatenated into code, which would be alarming anywhere else and is not
 *  here: everything downstream of this point is inside the Worker, and a plugin
 *  that escapes the function it was put in lands at the Worker's top level with
 *  precisely the same nothing available to it. See the note in ./sandbox.ts. */
function workerScript(source: string): string {
  const url = new URL(sandboxUrl, location.href).href;
  return [
    // Imported for its SIDE EFFECT, not for a named export. Vite builds
    // ./sandbox.ts as a worker entry; a worker entry has no importers, so
    // anything reachable only through an `export` is tree-shaken away. The
    // first version of this asked for `{ startPlugin }` and got a chunk that
    // did not have one.
    `import ${JSON.stringify(url)};`,
    `self[${JSON.stringify(START)}](async function (app) {`,
    source,
    `});`,
  ].join("\n");
}

export type SpawnOptions = Omit<RunOptions, "port" | "dispose"> & {
  /** Overridable so a test can supply a Worker that is not one. */
  makeWorker?: (script: string) => { port: Port; dispose: () => void };
};

/** Build the Worker, run the plugin in it, and take the Worker down.
 *
 *  TERMINATED, not asked to stop. A plugin that ran past its deadline or over
 *  its limits is by definition one that is not answering, so `dispose` is the
 *  only thing that actually ends it; `runInSandbox` calls it on every outcome,
 *  including the successful one. */
export async function spawnAndRun(opts: SpawnOptions): Promise<RunOutcome> {
  const make = opts.makeWorker ?? defaultWorker;
  const { port, dispose } = make(workerScript(opts.source));
  return await runInSandbox({ ...opts, port, dispose });
}

function defaultWorker(script: string): { port: Port; dispose: () => void } {
  const blob = new Blob([script], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url, { type: "module" });
  return {
    port: worker as unknown as Port,
    dispose: () => {
      worker.terminate();
      // Released once the Worker is gone rather than immediately after
      // construction: a URL revoked too early is a Worker that may never have
      // finished loading its own script, and the failure is a blank worker with
      // no error worth reading.
      URL.revokeObjectURL(url);
    },
  };
}

/** Exported for the test that checks what actually goes into the Worker. The
 *  generated script is the security-relevant artefact here, so it is worth
 *  being able to look at one without a browser. */
export const __workerScript = workerScript;
