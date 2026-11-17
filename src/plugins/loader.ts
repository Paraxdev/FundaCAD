// Evaluates a plugin's app-side code from a release with the app's whole reach, so Rust hands over only a verified
// bundle. `new Function`, not `import()`: `script-src 'self'` refuses blob URLs, see tests/security/csp.test.ts.

import type { Component } from "vue";
import { WordedError } from "../ui/wordedError";

/** Shared, not bundled: two Vues cannot see each other's refs, two Pinias split the stores, two three.js break
 *  `instanceof`. The keys are exactly `SHARED` in scripts/build-plugin-code.mjs, which the tests check. */
export type HostModules = Record<string, unknown>;

/** `activate` is the only thing called. */
export interface PluginModule {
  activate?: (engine: unknown) => Promise<() => void> | (() => void);
  [key: string]: unknown;
}

/** Whole namespaces cannot be tree-shaken, measured at about 24 kB gzipped (908 to 932 kB), worth it so a plugin can
 *  use all of Vue. Async, so a machine with nothing installed never pays for it. */
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

/** Mirrors EXPORT_NAME in scripts/build-plugin-code.mjs, and the tests hold the two together. */
export const EXPORT_NAME = "__fundacadPlugin";

/** `new Function` rather than `eval` keeps the plugin out of this scope: hygiene, not security, the origin rule is
 *  that. Throws with the plugin's id so the caller can say which plugin failed and why. */
export function evaluatePlugin(id: string, code: string, modules: HostModules): PluginModule {
  let factory: (host: HostModules) => unknown;
  try {
    factory = new Function(
      "__fundacadHost",
      `${code}\n;return typeof ${EXPORT_NAME} === "undefined" ? undefined : ${EXPORT_NAME};`,
    ) as (host: HostModules) => unknown;
  } catch (err) {
    throw new WordedError("plugins.error.noCompile", { id, why: msg(err) });
  }

  let exported: unknown;
  try {
    exported = factory(modules);
  } catch (err) {
    throw new WordedError("plugins.error.threwLoading", { id, why: msg(err) });
  }

  if (!exported || typeof exported !== "object") {
    throw new WordedError("plugins.error.noExport", { id, name: EXPORT_NAME });
  }
  return exported as PluginModule;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Re-exported so a plugin's contributed components have a name in this layer's types. */
export type { Component };
