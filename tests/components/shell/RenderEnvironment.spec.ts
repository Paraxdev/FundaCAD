import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import RenderEnvironment from "../../../src/components/shell/RenderEnvironment.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { useEnvLibrary } from "../../../src/ui/environmentImport";
import type { EnvEntry, EnvLibrary } from "../../../src/ui/environmentLibrary";

const entry = (id: string, name: string): EnvEntry => ({
  id,
  name,
  settings: { environment: "studio" } as EnvEntry["settings"],
  thumb: "",
  created: 0,
});

afterEach(() => useEnvLibrary(null));

describe("RenderEnvironment rename", () => {
  it("focuses the name field of the environment being renamed", async () => {
    const lib = {
      list: async () => [entry("a", "Alpha"), entry("b", "Beta")],
    } as unknown as EnvLibrary;
    useEnvLibrary(lib);
    const engine = {
      store: null,
      viewport: { qualityTier: () => "high", onRenderTierChange: () => () => {} },
    } as unknown as Engine;
    const w = mount(RenderEnvironment, {
      attachTo: document.body,
      global: { provide: { [ENGINE as symbol]: engine } },
    });
    await flushPromises();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await w.get('[data-rename="Beta"]').trigger("click");
    await flushPromises();
    expect(err).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(w.get("input.rd-name").element);
    w.unmount();
  });
});
