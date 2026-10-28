import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import RenderEnvironment from "../../../src/components/shell/RenderEnvironment.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { useEnvLibrary } from "../../../src/ui/environmentImport";
import type { EnvEntry, EnvLibrary } from "../../../src/ui/environmentLibrary";
import { DEFAULT_RENDER, renderPrefs, setRenderPref } from "../../../src/ui/renderPrefs";

const entry = (id: string, name: string): EnvEntry => ({
  id,
  name,
  settings: { environment: "studio" } as EnvEntry["settings"],
  thumb: "",
  created: 0,
});

afterEach(() => useEnvLibrary(null));

const mountEnv = (tier: object = {}) => {
  useEnvLibrary({ list: async () => [] } as unknown as EnvLibrary);
  const engine = {
    store: null,
    viewport: { qualityTier: () => tier, onRenderTierChange: () => () => {} },
  } as unknown as Engine;
  return mount(RenderEnvironment, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: engine } } });
};

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
    expect(document.activeElement).toBe(w.get(".rd-name input").element);
    w.unmount();
  });
});

describe("RenderEnvironment naming", () => {
  const mountLibrary = async () => {
    const calls: string[] = [];
    const lib = {
      list: async () => [entry("a", "Alpha")],
      save: async (name: string) => {
        calls.push(`save ${name}`);
        return entry("n", name);
      },
      rename: async (id: string, name: string) => {
        calls.push(`rename ${id} ${name}`);
        return entry(id, name);
      },
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
    return { w, calls };
  };
  const type = async (w: Awaited<ReturnType<typeof mountLibrary>>["w"], text: string) => {
    const input = w.get<HTMLInputElement>(".rd-name input");
    input.element.value = text;
    await input.trigger("input");
    return input;
  };

  it("saves under the typed name on Enter and puts the field away", async () => {
    const { w, calls } = await mountLibrary();
    await w.get("[data-env-save]").trigger("click");
    await flushPromises();
    const input = await type(w, "Dusk");
    expect(calls).toEqual([]);
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect({ calls, field: w.find(".rd-name").exists() }).toEqual({ calls: ["save Dusk"], field: false });
    w.unmount();
  });

  it("drops the name on Escape and saves nothing, not even on the blur that follows", async () => {
    const { w, calls } = await mountLibrary();
    await w.get("[data-env-save]").trigger("click");
    await flushPromises();
    const input = await type(w, "Dusk");
    await input.trigger("keydown", { key: "Escape" });
    await input.trigger("blur");
    await flushPromises();
    expect({ calls, field: w.find(".rd-name").exists() }).toEqual({ calls: [], field: false });
    w.unmount();
  });

  it("renames on blur, once", async () => {
    const { w, calls } = await mountLibrary();
    await w.get('[data-rename="Alpha"]').trigger("click");
    await flushPromises();
    const input = await type(w, "Bravo");
    await input.trigger("blur");
    await flushPromises();
    expect({ calls, field: w.find(".rd-name").exists() }).toEqual({ calls: ["rename a Bravo"], field: false });
    w.unmount();
  });
});

describe("RenderEnvironment rows", () => {
  afterEach(() => {
    for (const k of ["shadows", "potatoMode", "performanceMode", "brightness", "realtimeQuality", "denoise"] as const)
      setRenderPref(k, DEFAULT_RENDER[k] as never);
  });

  it("turns shadows and potato mode on and off with their checkboxes", async () => {
    setRenderPref("shadows", false);
    const w = mountEnv();
    await flushPromises();
    const shadows = w.get<HTMLInputElement>('[data-shadows="mode"] input');
    expect(shadows.element.checked).toBe(false);
    await shadows.trigger("change");
    expect(renderPrefs().shadows).toBe(true);
    await w.get('[data-potato="mode"] input').trigger("change");
    expect(renderPrefs().potatoMode).toBe(true);
    w.unmount();
  });

  it("holds performance mode checked and says why while potato mode is on", async () => {
    setRenderPref("potatoMode", true);
    setRenderPref("performanceMode", false);
    const w = mountEnv();
    await flushPromises();
    const row = w.get('[data-perf="mode"]');
    const box = w.get<HTMLInputElement>('[data-perf="mode"] input');
    expect(box.element.checked).toBe(true);
    expect(row.attributes("title") ?? box.attributes("title")).toBe("Potato mode includes performance mode");
    await box.trigger("change");
    expect(renderPrefs().performanceMode).toBe(false);
    w.unmount();
  });

  it("updates the brightness live as the slider moves", async () => {
    const w = mountEnv();
    await flushPromises();
    const input = w.get<HTMLInputElement>("#rd-brightness input");
    input.element.value = "1.5";
    await input.trigger("input");
    expect(renderPrefs().brightness).toBe(1.5);
    w.unmount();
  });

  it("picks a denoise level from the chips and refuses High quality on a tier that cannot run it", async () => {
    const w = mountEnv({ software: true });
    await flushPromises();
    await w.get('[data-denoise="high"]').trigger("click");
    expect(renderPrefs().denoise).toBe("high");
    expect(w.get('[data-denoise="high"]').attributes("aria-checked")).toBe("true");
    const high = w.get('[data-realtime-quality="high"]');
    expect(high.attributes("aria-disabled")).toBe("true");
    expect(high.attributes("title")).toBeTruthy();
    await high.trigger("click");
    expect(renderPrefs().realtimeQuality).not.toBe("high");
    w.unmount();
  });
});
