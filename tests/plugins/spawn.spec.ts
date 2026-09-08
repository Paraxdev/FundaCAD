// The script that actually becomes a Worker.
//
// This is the security-relevant artefact of the whole runner: the bytes the
// browser is asked to run. Everything else in the sandbox is testable over a
// MessageChannel; this is the one thing that is only true if the generated text
// is right, and it failed once already in a way nothing else would have caught.
//
// WHAT FAILED. The script asked for `import { startPlugin } from <chunk>`, and
// Vite builds ./sandbox.ts as a worker ENTRY. A worker entry has no importers,
// so everything reachable only through an export was tree-shaken out: the built
// chunk contained the op-name array and no `startPlugin` at all. Every unit
// test passed. It would have failed at the first line of the first plugin
// anybody ran, in a packaged build, with an error about an undefined export.
//
// So the two halves are held against each other here: the name ./sandbox.ts
// registers on the Worker global, and the name the generated script calls. And
// scripts/check-sandbox-chunk.mjs checks the third thing neither of these can,
// which is that the BUILT chunk still contains it.

import { describe, expect, it } from "vitest";

import { __workerScript, spawnAndRun } from "../../src/plugins/runner/spawn";
import { START } from "../../src/plugins/runner/protocol";
import sandboxSrc from "../../src/plugins/runner/sandbox.ts?raw";
import { testHost } from "../../src/plugins/broker/testing";
import type { Port } from "../../src/plugins/runner/protocol";

describe("the generated worker script", () => {
  const script = __workerScript(`return 1 + 1;`);

  it("imports the sandbox for its side effect, not for a named export", () => {
    // The exact shape that broke. `import { x } from` must not come back.
    expect(script).not.toMatch(/import\s*\{/);
    expect(script).toMatch(/^import "[^"]+";$/m);
  });

  it("calls the name the sandbox module actually registers", () => {
    expect(script).toContain(`self["${START}"]`);
    // And the sandbox really does register it, at the top level, where a
    // bundler cannot drop it.
    expect(sandboxSrc).toContain("[START] = startPlugin;");
    expect(sandboxSrc).toContain('import { START, type Port } from "./protocol";');
  });

  it("puts the plugin in as a function body, unaltered", () => {
    const plugin = `const x = await app.call("doc_get");\nreturn x;`;
    const out = __workerScript(plugin);
    expect(out).toContain(plugin);
    expect(out).toContain("async function (app) {");
  });

  it("does not use the Function constructor anywhere", () => {
    // The whole reason for this shape: compute plugins must not need
    // 'unsafe-eval'. tests/security/csp.test.ts is the other half of this.
    expect(script).not.toContain("Function(");
    expect(script).not.toContain("eval(");
  });
});

describe("spawning", () => {
  it("hands the generated script to whatever makes the Worker", async () => {
    let seen = "";
    const app = testHost();
    // A port that never answers, so the run ends on its deadline. What is being
    // checked is what went in, not what came out.
    const port: Port = {
      postMessage() {},
      addEventListener() {},
      removeEventListener() {},
    };
    const out = await spawnAndRun({
      plugin: "p",
      grants: ["document.read"],
      host: app,
      source: `return "hello";`,
      limits: { deadlineMs: 1 },
      makeWorker: (s) => {
        seen = s;
        return { port, dispose: () => {} };
      },
      setTimer: (fn) => {
        fn();
        return 0;
      },
      clearTimer: () => {},
    });

    expect(seen).toContain(`return "hello";`);
    expect(seen).toContain(`self["${START}"]`);
    expect(out).toMatchObject({ ok: false, reason: "timed-out" });
  });

  it("disposes of the Worker on every outcome, including the good one", async () => {
    let disposed = 0;
    const ch = new MessageChannel();
    ch.port1.start();
    ch.port2.start();
    // Stand in for the sandbox: say ready, then say done.
    ch.port2.addEventListener("message", (ev) => {
      const m = ev.data as { t: string };
      if (m.t === "start") ch.port2.postMessage({ t: "done", value: 7 });
    });
    queueMicrotask(() => ch.port2.postMessage({ t: "ready" }));

    const out = await spawnAndRun({
      plugin: "p",
      grants: [],
      host: testHost(),
      source: "return 7;",
      makeWorker: () => ({
        port: ch.port1 as unknown as Port,
        dispose: () => {
          disposed += 1;
          ch.port1.close();
          ch.port2.close();
        },
      }),
    });

    expect(out).toMatchObject({ ok: true, value: 7 });
    // Once, not never and not twice. A Worker left running after a successful
    // plugin is the leak nobody notices, because everything looked fine.
    expect(disposed).toBe(1);
  });
});
