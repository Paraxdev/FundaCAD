// Starts a real Worker for a plugin, the one browser-only file here. The plugin is inlined into a blob script importing
// ./sandbox.ts, so it needs `worker-src 'self' blob:` and no 'unsafe-eval', as e2e/sandbox_csp.cjs measures.

import { runInSandbox, type RunOptions, type RunOutcome } from "./host";
import { START, type Port } from "./protocol";

// Vite compiles this to an ES module chunk URL on the app's own origin, the only thing the blob may import.
import sandboxUrl from "./sandbox?worker&url";

/** Untrusted text concatenated into code, safe only because all of it runs inside the Worker. See ./sandbox.ts. */
function workerScript(source: string): string {
  const url = new URL(sandboxUrl, location.href).href;
  return [
    // For its side effect: Vite tree-shakes a worker entry's exports, see ./sandbox.ts.
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

/** Terminated, not asked to stop: a plugin past its limits is not answering. `runInSandbox` disposes on every
 *  outcome. */
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
      // Revoked only once the Worker is gone: revoking early can leave a blank worker that never loaded its script.
      URL.revokeObjectURL(url);
    },
  };
}

/** For the test that inspects the generated script, the security-relevant artefact, without a browser. */
export const __workerScript = workerScript;
