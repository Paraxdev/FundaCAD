// Which of the shipped plugins' app-side modules run.
//
// Two different questions, and the point of this file is that they stay two. A
// BUILT-IN is active when its switch is on: its code is the app's code and the
// switch is the whole of the decision. A BUNDLE is active when it is installed
// on disk — its source living in this repository is not the same as somebody
// having it, and a companion that ran anyway would put a plugin's settings, and
// its badge, in front of every person who never installed it.

import { afterEach, describe, expect, it, vi } from "vitest";

import { shippedPlugins } from "../../src/plugins/shipped";
import type { Engine } from "../../src/app/engine";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Nothing here needs an engine: the modules under test contribute settings and
 *  touch no document. The two that DO take an engine are not started. */
const NO_ENGINE = {} as Engine;

/** Wait for a condition, or give up.
 *
 *  Activation is a dynamic import of a module that itself imports a component,
 *  so how long it takes depends on what else the runner is doing. A fixed sleep
 *  long enough on an idle machine is a flake on a busy one, and long enough on a
 *  busy one is time added to every run. Polling is neither. */
async function until(ok: () => boolean, ms = 2000): Promise<void> {
  const stop = Date.now() + ms;
  while (!ok() && Date.now() < stop) await new Promise((r) => setTimeout(r, 5));
}

/** ...and the other half: a thing that must NOT happen needs a settled moment,
 *  not a condition, so this is the one place a wait is unavoidable. Short,
 *  because what it is waiting out is a microtask queue rather than work. */
const settle = () => new Promise((r) => setTimeout(r, 50));

/** Load activate.ts with a chosen set of installed ids, and hand back the
 *  contribution table IT will write into.
 *
 *  The table comes from the same freshly-reset module graph, not from an import
 *  at the top of this file: `resetModules` gives activate.ts its own copy of
 *  every module it imports, so a contribution made through that copy is
 *  invisible to any other. */
async function withInstalled(ids: string[]) {
  vi.resetModules();
  vi.doMock("../../src/plugins/index", () => ({
    installedIds: () => new Set(ids),
    onInstalledChange: () => () => {},
    refreshInstalled: async () => {},
  }));
  const [activate, contrib, registry] = await Promise.all([
    import("../../src/plugins/activate"),
    import("../../src/plugins/contrib"),
    import("../../src/plugins/registry"),
  ]);
  return { ...activate, ...contrib, ...registry };
}

describe("which shipped plugins have an app-side module at all", () => {
  it("finds one for every plugin that ships a main.ts", () => {
    // The control for everything below: a glob that matched nothing would make
    // every case here pass while starting not one plugin.
    const ids = shippedPlugins().map((p) => p.dir);
    expect(ids.length).toBeGreaterThan(3);
  });
});

describe("a bundle's companion", () => {
  it("does not run when the bundle is not installed", async () => {
    const { activatePlugins, contributedSettings } = await withInstalled([]);
    const stop = activatePlugins(NO_ENGINE);
    await settle();
    // No settings block, so Preferences has nothing to draw for it. This is the
    // ordinary state of every machine that never installed the plugin.
    expect(contributedSettings()).toEqual([]);
    stop();
  });

  it("runs when it is installed, and stops when it goes", async () => {
    const { activatePlugins, contributedSettings } = await withInstalled(["FundaCAD.MCP"]);
    const stop = activatePlugins(NO_ENGINE);
    await until(() => contributedSettings().length > 0);
    expect(contributedSettings().map((s) => s.section.title)).toEqual(["Assistants"]);
    stop();
    expect(contributedSettings()).toEqual([]);
  });

  it("is not started by the built-in switch", async () => {
    // The control that keeps the two questions apart. Turning a switch on for an
    // id that is not a built-in must decide nothing: the stored state can hold
    // any id at all (it is read forward from older versions), and a bundle whose
    // companion answered to it would run without the bundle being there.
    const { activatePlugins, contributedSettings, setPluginEnabled } = await withInstalled([]);
    setPluginEnabled("FundaCAD.MCP", true);
    const stop = activatePlugins(NO_ENGINE);
    await settle();
    expect(contributedSettings()).toEqual([]);
    stop();
  });
});
