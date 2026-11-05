// Starts a real Worker for a plugin, the one browser-only file here. The plugin is inlined into a blob script importing
// ./sandbox.ts, so it needs `worker-src 'self' blob:` and no 'unsafe-eval', as e2e/sandbox_csp.cjs measures.

import { runInSandbox, type RunOptions, type RunOutcome } from "./host";
import { MAX_LOG, START, type Port } from "./protocol";

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

type Spawned = Pick<RunOptions, "port" | "dispose" | "watch">;

export type SpawnOptions = Omit<RunOptions, "port" | "dispose" | "watch"> & {
  /** Overridable so a test can supply a Worker that is not one. */
  makeWorker?: (script: string) => Spawned;
};

/** Terminated, not asked to stop: a plugin past its limits is not answering. `runInSandbox` disposes on every
 *  outcome. */
export async function spawnAndRun(opts: SpawnOptions): Promise<RunOutcome> {
  const make = opts.makeWorker ?? defaultWorker;
  const spawned = make(workerScript(opts.source));
  return await runInSandbox({ ...opts, ...spawned });
}

function defaultWorker(script: string): Spawned {
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
    watch: (fail) => {
      // A script that fails to load or throws at the top level reaches only the Worker, never its port.
      worker.addEventListener("error", (ev) => {
        ev.preventDefault();
        const detail = ev instanceof ErrorEvent && ev.message ? `: ${ev.message.slice(0, MAX_LOG)}` : "";
        fail(`the plugin's sandbox stopped with an error${detail}`, "plugin-failed");
      });
      worker.addEventListener("messageerror", () =>
        fail("the sandbox sent a message that could not be read", "sandbox-lost"),
      );
    },
  };
}

/** For the test that inspects the generated script, the security-relevant artefact, without a browser. */
export const __workerScript = workerScript;
