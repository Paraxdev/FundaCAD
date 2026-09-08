// The Content-Security-Policy, and the one dependency that constrains it.
//
// The 2D constraint solver was dead in every packaged build and nothing in this
// suite could see it. planegcs is an emscripten/embind module; embind builds
// each invoker by handing SOURCE TEXT to the `Function` constructor, and
// `'wasm-unsafe-eval'` permits WebAssembly compilation only, not that. So the
// policy refused the solver, `tauri dev` served from vite with no CSP and never
// showed it, and vitest runs in Node, which has no CSP either.
//
// These tests cannot execute a policy. What they CAN do is hold the policy and
// the artifact it exists for against each other, so the pair cannot drift
// silently in either direction:
//
//   - the glue still needs 'unsafe-eval'  ->  the policy must still grant it
//   - the glue stops needing it           ->  this test fails, and the policy
//                                             should be tightened again
//
// The second direction is the point. Without it, `'unsafe-eval'` would sit in a
// privileged webview's policy forever after the reason for it had gone.
//
// e2e/solver_csp.cjs is the test that actually runs the solver under the real
// policy in a real browser. This one is the fast guard.

import { describe, expect, it } from "vitest";

// Loaded through vite rather than node:fs, the way tests/components/vHtmlPolicy
// does, so this file needs no node type declarations and no __dirname.
import confRaw from "../../src-tauri/tauri.conf.json?raw";
// The glue the app actually loads: src/sketch/solver.ts imports
// `@salusoft89/planegcs`, which resolves to this file.
import glue from "../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.js?raw";
// The app's own second use of the Function constructor. Read as TEXT, like the
// glue above, so this test measures what the file does rather than what a
// comment about it says.
import loader from "../../src/plugins/loader.ts?raw";

const conf = JSON.parse(confRaw) as {
  app: { security: { csp: string; devCsp: string } };
};

/** One CSP directive's source list. */
function directive(csp: string, name: string): string[] {
  const found = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
  return found ? found.split(/\s+/).slice(1) : [];
}

describe("Content-Security-Policy", () => {
  it("keeps every policy in step, so devCsp cannot hide a break in csp", () => {
    // The only difference between them should be development conveniences, not
    // script-src: a devCsp that grants more is exactly how this class of bug
    // stays invisible until someone packages a build.
    const { csp, devCsp } = conf.app.security;
    expect(directive(devCsp, "script-src")).toEqual(directive(csp, "script-src"));
  });

  it("does not allow inline script, which would defeat the policy wholesale", () => {
    for (const csp of [conf.app.security.csp, conf.app.security.devCsp]) {
      expect(directive(csp, "script-src")).not.toContain("'unsafe-inline'");
    }
  });

  it("embeds no remote frames", () => {
    // The welcome screen used to embed a cross-origin page. Nothing does now,
    // and re-adding one would reopen the app's only remote-content surface.
    for (const csp of [conf.app.security.csp, conf.app.security.devCsp]) {
      expect(directive(csp, "frame-src")).toEqual(["'none'"]);
    }
  });

  it("lets a plugin sandbox be a worker on a blob, and nothing else be one", () => {
    // src/plugins/runner/spawn.ts inlines a plugin's code into a blob and
    // starts a module Worker on it. Without this grant the Worker cannot be
    // created at all: `worker-src` is unset by default and falls back to
    // `script-src`, which does not list blob:.
    //
    // e2e/sandbox_csp.cjs is the test that runs that for real, under this
    // policy, in a browser. This is the fast guard that the grant is still here.
    for (const csp of [conf.app.security.csp, conf.app.security.devCsp]) {
      expect(directive(csp, "worker-src")).toEqual(["'self'", "blob:"]);
    }
  });

  it("does not let a blob become a script in the window itself", () => {
    // The whole reason the sandbox uses `worker-src` rather than loosening
    // `script-src`: a blob may become a Worker, which has no DOM and one port,
    // and may NOT become a script in the page, which has everything. Two
    // directives, and only the narrow one is granted.
    for (const csp of [conf.app.security.csp, conf.app.security.devCsp]) {
      expect(directive(csp, "script-src")).not.toContain("blob:");
      expect(directive(csp, "default-src")).not.toContain("blob:");
    }
  });

  it("grants 'unsafe-eval' for reasons it can name, and no others", () => {
    // TWO reasons now, and this test exists so the count is a fact rather than a
    // memory. It used to be one, and the comment here said so at length.
    //
    // FIRST: `var a=Function` is embind's `new_` helper as the minifier left it,
    // and `a.apply(c, b)` invokes the Function constructor with a source string.
    // Nothing about planegcs has changed.
    //
    // SECOND: src/plugins/loader.ts, which evaluates the app-side module of an
    // installed plugin. That one is a DELIBERATE addition and it is worth being
    // precise about why it could not be avoided. A plugin that draws — a menu
    // row, a component, paint on the model — runs in the app's own context;
    // none of that is expressible from a Worker or a process. And the policy is
    // `script-src 'self'` with `worker-src 'self' blob:`, so a blob URL is not a
    // script source: `import(URL.createObjectURL(...))` is refused, and so is a
    // data: URL. The Function constructor is what is left.
    //
    // THE COMPUTE SANDBOX IS STILL NOT ONE OF THE REASONS, and that distinction
    // is the point of keeping this list. The obvious sandbox hands a plugin's
    // text to the Function constructor; that one inlines it into the worker's
    // own script instead, so a compute plugin holds no opinion about
    // 'unsafe-eval' and cannot block its removal. e2e/sandbox_csp.cjs runs the
    // sandbox under this policy with the grant stripped out, to keep that true.
    const reasons = [
      glue.includes("var a=Function") && "planegcs hands source text to the Function constructor",
      loader.includes("new Function(") && "src/plugins/loader.ts evaluates an installed plugin's module",
    ].filter(Boolean) as string[];
    const granted = directive(conf.app.security.csp, "script-src").includes("'unsafe-eval'");

    if (reasons.length) {
      expect(
        granted,
        `the policy must keep 'unsafe-eval': ${reasons.join("; ")}`,
      ).toBe(true);
    } else {
      expect(
        granted,
        "nothing needs the Function constructor any more, so 'unsafe-eval' should be " +
          "removed from script-src in src-tauri/tauri.conf.json",
      ).toBe(false);
    }
  });
});
