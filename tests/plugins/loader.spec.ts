// A plugin, built the way a release builds it, run the way the app runs it.
//
// Nothing here is a stand-in. scripts/build-plugin-code.mjs compiles a real
// plugin directory into the single module a bundle carries; src/plugins/loader
// evaluates that text against the real host modules; and what comes out is
// asked to contribute to the real table. If a plugin can be built and cannot be
// run, or can be run and reaches nothing, this is where it shows.
//
// It is slow — a vite build per case — and it is worth it. Every cheaper version
// of this test replaces the one thing that keeps being wrong: what the build
// leaves external, and whether the loader supplies exactly that.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  EXPORT_NAME,
  evaluatePlugin,
  hostModules,
  type HostModules,
} from "../../src/plugins/loader";
import { contributors, resetContributions } from "../../src/plugins/contrib";

// The build script is ESM and imports vite; loaded through the same graph so
// there is one vite, not two.
import { SHARED, EXPORT_NAME as BUILD_EXPORT_NAME, buildPlugin } from "../../scripts/build-plugin-code.mjs";

let modules: HostModules;
const built = new Map<string, string>();

beforeAll(async () => {
  modules = await hostModules();
}, 60_000);

afterEach(() => resetContributions());
afterAll(() => resetContributions());

async function code(id: string): Promise<string> {
  const cached = built.get(id);
  if (cached) return cached;
  // Relative to the working directory, which is the repository root under
  // vitest. Node built-ins are avoided on purpose: this repository has no
  // @types/node, and one import of `path` would need it.
  const js = await buildPlugin(`plugins/${id}`, null);
  built.set(id, js);
  return js;
}

describe("the two halves name the same things", () => {
  it("agrees on where a built module puts its exports", () => {
    // The build assigns to this name and the loader reads it back. Two spellings
    // is a plugin that builds, loads, and hands back undefined.
    expect(EXPORT_NAME).toBe(BUILD_EXPORT_NAME);
  });

  it("supplies exactly what the build leaves external", async () => {
    // The list that must not drift. A module the build externalises and the
    // loader does not supply evaluates to `undefined` and dies at its first use;
    // one the loader supplies and the build bundles anyway is a SECOND COPY,
    // which does not die at all — it quietly gives the plugin its own Vue, its
    // own Pinia registry or its own three.js, and looks like a plugin whose
    // components never update.
    expect(Object.keys(modules).sort()).toEqual([...SHARED].sort());
    for (const id of SHARED) {
      expect(modules[id], id).toBeTruthy();
    }
  });
});

describe("a plugin built for a release", () => {
  it("evaluates and exports an activate", async () => {
    const m = evaluatePlugin("FundaCAD.MultiColor", await code("FundaCAD.MultiColor"), modules);
    expect(typeof m.activate).toBe("function");
  }, 60_000);

  it("runs, and reaches the app's contribution table", async () => {
    const m = evaluatePlugin("FundaCAD.MultiColor", await code("FundaCAD.MultiColor"), modules);
    // The narrowest engine this one touches. It reads the palette and the build
    // result off the store and never calls the kernel.
    const engine = {
      store: {
        colorPalette: [{ name: "Red", color: "#ff0000" }],
        buildState: { result: { bodies: [] } },
        bodyColorSlot: () => undefined,
      },
    };
    const stop = await m.activate!(engine);
    expect(contributors()).toEqual(["FundaCAD.MultiColor"]);
    stop();
    expect(contributors()).toEqual([]);
  }, 60_000);

  it("shares the app's Vue rather than bringing its own", async () => {
    // The failure this catches is silent: a plugin with its own Vue renders
    // once and never again, because the app's reactive effects and the plugin's
    // are two systems that cannot see each other. Checked on the ARTIFACT —
    // whether the built module carries Vue's source or asks the host for it.
    const js = await code("FundaCAD.MultiColor");
    expect(js).toContain('__fundacadHost["vue"]');
    // Vue's own module banner would be in there if it had been bundled.
    expect(js).not.toContain("__VUE_PROD_HYDRATION_MISMATCH_DETAILS__");
  }, 60_000);

  it("keeps the app's own modules out of the bundle", async () => {
    // `fundacad` is the promise; bundling it would give the plugin a second
    // contribution table, so `contribute` would write somewhere nothing reads.
    const js = await code("FundaCAD.MultiColor");
    expect(js).toContain('__fundacadHost["fundacad"]');
  }, 60_000);
});

describe("what the loader refuses", () => {
  it("says which plugin when the code will not compile", () => {
    expect(() => evaluatePlugin("A.One", "this is not javascript {", modules))
      .toThrow(/A\.One: its code would not compile/);
  });

  it("says which plugin when the code throws on load", () => {
    expect(() => evaluatePlugin("A.One", `throw new Error("boom");`, modules))
      .toThrow(/A\.One: its code threw while loading: boom/);
  });

  it("refuses code that was not built by the packager", () => {
    // Valid JavaScript that simply is not a plugin. Without this the app would
    // get `undefined` and fail later, somewhere with no plugin id in it.
    expect(() => evaluatePlugin("A.One", "var x = 1;", modules))
      .toThrow(/A\.One: its code defined no __fundacadPlugin/);
  });

  it("hands the plugin nothing but the host argument", () => {
    // Hygiene rather than security — the code has the whole window either way,
    // which is what the origin rule in loader.ts is for. But a plugin must not
    // be able to see the loader's own locals, or a rename in that file would
    // change what plugins can reach.
    const m = evaluatePlugin(
      "A.One",
      `var ${EXPORT_NAME} = { names: Object.keys(this || {}), typeofCode: typeof code };`,
      modules,
    );
    expect(m.typeofCode).toBe("undefined");
  });
});
