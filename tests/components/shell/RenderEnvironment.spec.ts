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
