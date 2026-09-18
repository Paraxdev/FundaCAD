// An install that still has the old MCP plugin, from before MCP was part of the
// app: it is removed on the first listing, never reported as installed, and so
// its companion never starts next to the core MCP section.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const tauri = vi.hoisted(() => ({
  installed: [] as { id: string }[],
  removed: [] as string[],
  refuseRemove: false,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: { id?: string }) => {
    if (cmd === "plugin_list") return tauri.installed.map((r) => ({ ...r }));
    if (cmd === "plugin_remove") {
      if (tauri.refuseRemove) throw "access denied";
      tauri.removed.push(args!.id!);
      tauri.installed = tauri.installed.filter((r) => r.id !== args!.id);
      return undefined;
    }
    throw new Error(`unexpected ${cmd}`);
  },
}));

import { installedIds, installedPlugins, RETIRED_PLUGINS } from "../../src/plugins";
import { useToastStore } from "../../src/stores/toasts";

beforeEach(() => {
  setActivePinia(createPinia());
  (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  tauri.installed = [{ id: "FundaCAD.MCP" }, { id: "FundaCAD.Screws" }];
  tauri.removed = [];
  tauri.refuseRemove = false;
});
afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("a plugin whose job moved into the app", () => {
  it("names the MCP plugin", () => {
    expect(RETIRED_PLUGINS.map((r) => r.id)).toEqual(["FundaCAD.MCP"]);
  });

  it("is removed from disk, left out of the list, and the person is told", async () => {
    const list = await installedPlugins();
    expect(tauri.removed).toEqual(["FundaCAD.MCP"]);
    expect(list.map((r) => r.id)).toEqual(["FundaCAD.Screws"]);
    expect([...installedIds()]).toEqual(["FundaCAD.Screws"]);
    expect(useToastStore().items.map((t) => t.message).join(" ")).toContain("part of FundaCAD now");

    // Gone for good: the next listing has nothing left to remove.
    await installedPlugins();
    expect(tauri.removed).toEqual(["FundaCAD.MCP"]);
  });

  it("matches the id the way the file system does", async () => {
    tauri.installed = [{ id: "fundacad.mcp" }];
    expect(await installedPlugins()).toEqual([]);
    expect(tauri.removed).toEqual(["fundacad.mcp"]);
  });

  it("is still not started when it cannot be removed", async () => {
    tauri.refuseRemove = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const list = await installedPlugins();
    expect(list.map((r) => r.id)).toEqual(["FundaCAD.Screws"]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("leaves every other plugin alone", async () => {
    tauri.installed = [{ id: "FundaCAD.Screws" }, { id: "someone.mcp-tools" }];
    expect((await installedPlugins()).map((r) => r.id)).toEqual(["FundaCAD.Screws", "someone.mcp-tools"]);
    expect(tauri.removed).toEqual([]);
  });
});
