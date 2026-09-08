// Running a plugin's code that came from a release rather than from this build.
//
// A plugin that DRAWS runs in the application's own JavaScript context. It has
// to: a menu row, a Vue component, paint on the model and a call into the
// viewport are none of them expressible from a Worker or from a process. So
// there is no sandbox to put such a plugin in, and pretending otherwise on the
// consent screen would be the worst of both.
//
// What there is instead is an ORIGIN RULE, and it is the whole of the argument
// for this file existing:
//
//   Code loaded this way runs with the application's own reach. Therefore it is
//   loaded only from a bundle this project signed, and `sandboxNote("builtin")`
//   already tells the person exactly that, in the words they will read on the
//   screen where they decide.
//
// src-tauri is where that rule is enforced, because it is where the bytes are:
// the frontend cannot check a signature over a string it was handed by the same
// call it is trusting. `plugin_code` returns the module text only for an
// install whose bundle verified, and returns nothing at all otherwise. This
// module's job is to evaluate what it is given and to fail clearly when it
// cannot.
//
// WHY `new Function` AND NOT `import()`. The webview's policy is
// `script-src 'self'` with `worker-src 'self' blob:`. A blob URL is not a
// script source, so `import(URL.createObjectURL(...))` is refused; a data: URL
// likewise. `'unsafe-eval'` is already in the policy for planegcs's embind glue,
// and this is the second thing that needs it. tests/security/csp.test.ts says so
// rather than leaving the grant looking like one module's problem.

import type { Component } from "vue";

/** The modules a built plugin resolves against the running app.
 *
 *  Every one is a module the app ALREADY HAS, and sharing them is not a size
 *  optimisation. Two copies of Vue is two reactivity systems that cannot see
 *  each other's refs; two Pinias is two store registries, so the same
 *  `defineStore` call in a plugin and in its own component returns different
 *  stores; two three.js is `instanceof` failing between them, which the
 *  viewport uses to decide what it was handed. Each fails at runtime, quietly,
 *  looking like a bug in the plugin.
 *
 *  The keys are exactly the `SHARED` list in scripts/build-plugin-code.mjs. A
 *  plugin built against a name this map does not have would evaluate to
 *  `undefined` and die on its first use of it, which is why buildHost() is
 *  checked against that list in the tests rather than trusted. */
export type HostModules = Record<string, unknown>;

/** What a plugin's built module exports. `activate` is the only thing called. */
export interface PluginModule {
  activate?: (engine: unknown) => Promise<() => void> | (() => void);
  [key: string]: unknown;
}

/** Assemble the module map. Async because every module in it is one this app
 *  loads lazily itself, and a plugin is not a reason to pull Vue's whole
 *  surface, three.js and the host into the first chunk. */
export async function hostModules(): Promise<HostModules> {
  const [vue, pinia, three, fundacad, ui] = await Promise.all([
    import("vue"),
    import("pinia"),
    import("three"),
    import("./host"),
    import("./hostUi"),
  ]);
  return {
    vue,
    pinia,
    three,
    fundacad,
    "fundacad/ui": ui,
  };
}

/** The variable a built module assigns its exports to. Mirrors EXPORT_NAME in
 *  scripts/build-plugin-code.mjs; the tests hold the two together. */
export const EXPORT_NAME = "__fundacadPlugin";

/** Evaluate a built plugin module and hand back what it exported.
 *
 *  `new Function` rather than `eval`: the body is compiled in its own scope with
 *  exactly two names in it, so the plugin cannot see this function's locals, and
 *  nothing it declares leaks into the module that called it. That is a hygiene
 *  property and NOT a security one — the code has the whole window either way,
 *  which is what the origin rule above is for.
 *
 *  Throws with the plugin's id in the message. A plugin that will not evaluate
 *  is a feature missing from the window; the caller decides whether that is
 *  fatal, and this one's job is to say which plugin and why. */
export function evaluatePlugin(id: string, code: string, modules: HostModules): PluginModule {
  let factory: (host: HostModules) => unknown;
  try {
    factory = new Function(
      "__fundacadHost",
      `${code}\n;return typeof ${EXPORT_NAME} === "undefined" ? undefined : ${EXPORT_NAME};`,
    ) as (host: HostModules) => unknown;
  } catch (err) {
    throw new Error(`${id}: its code would not compile: ${msg(err)}`);
  }

  let exported: unknown;
  try {
    exported = factory(modules);
  } catch (err) {
    throw new Error(`${id}: its code threw while loading: ${msg(err)}`);
  }

  if (!exported || typeof exported !== "object") {
    throw new Error(
      `${id}: its code defined no ${EXPORT_NAME}. It was probably not built by ` +
      "scripts/build-plugin-code.mjs.",
    );
  }
  return exported as PluginModule;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A component, as far as the app is concerned. Re-exported so a plugin's
 *  contributed components have a name in this layer's types. */
export type { Component };
