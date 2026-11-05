// A plugin switched off and on again while its code is still loading.

import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enabled: true,
  listeners: [] as (() => void)[],
  loads: [] as ((m: unknown) => void)[],
}));

vi.mock("../../src/plugins/index", () => ({
  installedGrants: () => undefined,
  installedIds: () => new Set<string>(),
  onInstalledChange: () => () => {},
  pluginCode: async () => null,
  refreshInstalled: async () => {},
}));
vi.mock("../../src/plugins/registry", () => ({
  pluginEnabled: () => h.enabled,
  onPluginChange: (fn: () => void) => {
    h.listeners.push(fn);
    return () => {};
  },
}));
vi.mock("../../src/plugins/contrib", () => ({ setGrantLookup: () => {} }));
vi.mock("../../src/plugins/shipped", () => ({ shippedPlugins: () => [] }));
vi.mock("../../src/plugins/loader", () => ({ evaluatePlugin: () => null, hostModules: async () => ({}) }));
vi.mock("../../src/plugins/devPlugins", () => ({
  devLoaders: { "A.One": () => new Promise((resolve) => h.loads.push(resolve)) },
}));

import { activatePlugins } from "../../src/plugins/activate";
import type { Engine } from "../../src/app/engine";

const flush = () => new Promise((r) => setTimeout(r, 0));
const toggle = (on: boolean) => {
  h.enabled = on;
  for (const fn of h.listeners) fn();
};

afterEach(() => {
  h.enabled = true;
  h.listeners.length = 0;
  h.loads.length = 0;
});

function plugin() {
  const stops: ReturnType<typeof vi.fn>[] = [];
  const activate = vi.fn(async () => {
    const stop = vi.fn();
    stops.push(stop);
    return stop;
  });
  return { stops, activate, module: { activate } };
}

describe("a plugin toggled while it loads", () => {
  it("is activated once when switched off and on before its load finishes", async () => {
    const p = plugin();
    const teardown = activatePlugins({} as Engine);
    await flush();
    expect(h.loads).toHaveLength(1);

    toggle(false);
    toggle(true);
    await flush();
    for (const resolve of h.loads) resolve(p.module);
    await flush();

    expect(p.activate).toHaveBeenCalledTimes(1);
    teardown();
    expect(p.stops).toHaveLength(1);
    expect(p.stops[0]).toHaveBeenCalledTimes(1);
  });

  it("is stopped when switched off before its load finishes", async () => {
    const p = plugin();
    const teardown = activatePlugins({} as Engine);
    await flush();

    toggle(false);
    await flush();
    for (const resolve of h.loads) resolve(p.module);
    await flush();

    expect(p.stops.every((s) => s.mock.calls.length === 1)).toBe(true);
    teardown();
    expect(p.stops.every((s) => s.mock.calls.length === 1)).toBe(true);
  });

  it("stops every instance it started when switched off, on and off again", async () => {
    const p = plugin();
    const teardown = activatePlugins({} as Engine);
    await flush();

    toggle(false);
    toggle(true);
    await flush();
    for (const resolve of h.loads) resolve(p.module);
    await flush();
    toggle(false);

    expect(p.stops.length).toBeGreaterThan(0);
    expect(p.stops.every((s) => s.mock.calls.length === 1)).toBe(true);
    teardown();
  });
});
