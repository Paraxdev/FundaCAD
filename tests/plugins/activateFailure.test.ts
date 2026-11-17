// A plugin that will not start, such as one refused for an empty label, tells the person which and why.

import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  module: null as unknown,
  shipped: [] as { dir: string; manifest: { id: string; name: string } }[],
  toasts: [] as [string, { kind?: string; detail?: unknown }][],
}));

vi.mock("../../src/plugins/index", () => ({
  installedGrants: () => undefined,
  installedIds: () => new Set<string>(),
  onInstalledChange: () => () => {},
  pluginCode: async () => null,
  refreshInstalled: async () => {},
}));
vi.mock("../../src/plugins/registry", () => ({
  pluginEnabled: () => true,
  onPluginChange: () => () => {},
}));
vi.mock("../../src/plugins/contrib", () => ({ setGrantLookup: () => {} }));
vi.mock("../../src/plugins/shipped", () => ({ shippedPlugins: () => h.shipped }));
vi.mock("../../src/plugins/loader", () => ({ evaluatePlugin: () => null, hostModules: async () => ({}) }));
vi.mock("../../src/plugins/devPlugins", () => ({ devLoaders: { "A.Demo": async () => h.module } }));
vi.mock("../../src/ui/toast", () => ({
  toast: (message: string, opts: { kind?: string; detail?: unknown } = {}) => {
    h.toasts.push([message, opts]);
    return 1;
  },
}));

import { activatePlugins } from "../../src/plugins/activate";
import type { Engine } from "../../src/app/engine";

const flush = () => new Promise((r) => setTimeout(r, 0));
const EMPTY = "A.Demo gives the ribbon item in Tools an empty label, a screen reader could not name it";

afterEach(() => {
  h.module = null;
  h.shipped = [];
  h.toasts.length = 0;
  vi.restoreAllMocks();
});

async function start() {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const teardown = activatePlugins({} as Engine);
  await flush();
  await flush();
  teardown();
}

describe("a plugin that will not start", () => {
  it("shows an error naming the plugin and the empty label", async () => {
    h.shipped = [{ dir: "A.Demo", manifest: { id: "A.Demo", name: "Demo Tools" } }];
    const err = new Error(EMPTY);
    h.module = { activate: async () => Promise.reject(err) };
    await start();
    expect(h.toasts).toHaveLength(1);
    const [message, opts] = h.toasts[0]!;
    expect(message).toContain("Demo Tools");
    expect(message).toContain("could not start");
    expect(message).toContain("gives the ribbon item in Tools an empty label");
    expect(opts.kind).toBe("error");
    expect(opts.detail).toBe(err);
  });

  it("names it by its id when no manifest is at hand", async () => {
    h.module = { activate: async () => Promise.reject(new Error("boom")) };
    await start();
    expect(h.toasts.map(([m]) => m)).toEqual(["The A.Demo plugin could not start: boom"]);
  });

  it("shows nothing for a plugin that starts", async () => {
    h.module = { activate: async () => () => {} };
    await start();
    expect(h.toasts).toEqual([]);
  });
});
