import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import RenderEnvironment from "../../../src/components/shell/RenderEnvironment.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { chooseBuiltInEnvironment, useEnvLibrary } from "../../../src/ui/environmentImport";
import type { EnvEntry, EnvLibrary } from "../../../src/ui/environmentLibrary";
import { DEFAULT_RENDER, ENVIRONMENTS_LIST, renderPrefs, setRenderPref } from "../../../src/ui/renderPrefs";
import { denoiserState } from "../../../src/viewport/pathtrace/denoiser";

const entry = (id: string, name: string): EnvEntry => ({
  id,
  name,
  settings: { environment: "studio" } as EnvEntry["settings"],
  thumb: "",
  created: 0,
});

afterEach(() => {
  chooseBuiltInEnvironment(null, "studio");
  useEnvLibrary(null);
});

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
    await w.get('[data-saved-environment="Beta"]').trigger("click");
    await flushPromises();
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
    await w.get('[data-saved-environment="Alpha"]').trigger("click");
    await flushPromises();
    await w.get('[data-rename="Alpha"]').trigger("click");
    await flushPromises();
    const input = await type(w, "Bravo");
    await input.trigger("blur");
    await flushPromises();
    expect({ calls, field: w.find(".rd-name").exists() }).toEqual({ calls: ["rename a Bravo"], field: false });
    w.unmount();
  });
});

describe("RenderEnvironment tiles", () => {
  // Vue drops a bubbling event a listener attached in the same millisecond, which a test can reach and a keypress cannot.
  const key = async (el: Element, k: string) => {
    const t = Date.now();
    while (Date.now() === t);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    await flushPromises();
  };
  const mountSaved = async () => {
    const calls: string[] = [];
    useEnvLibrary({
      list: async () => [entry("a", "Alpha"), entry("b", "Beta")],
      rename: async (id: string, name: string) => {
        calls.push(`rename ${id} ${name}`);
        return entry(id, name);
      },
      remove: async (id: string) => {
        calls.push(`remove ${id}`);
      },
    } as unknown as EnvLibrary);
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

  it("holds the Studio tiles on one Tab stop, the arrows only move focus and Space or Enter picks", async () => {
    const w = mountEnv();
    await flushPromises();
    const grid = w.get('[role="listbox"][aria-label="Environment"]');
    const tiles = grid.findAll<HTMLElement>("[data-environment]");
    expect(tiles.map((t) => t.attributes("role"))).toEqual(ENVIRONMENTS_LIST.map(() => "option"));
    expect(tiles.filter((t) => t.attributes("tabindex") === "0").map((t) => t.attributes("data-environment"))).toEqual([
      "studio",
    ]);
    tiles[0]!.element.focus();
    await key(tiles[0]!.element, "ArrowRight");
    expect(document.activeElement).toBe(tiles[1]!.element);
    expect(renderPrefs().environment).toBe("studio");
    await key(tiles[1]!.element, " ");
    expect(renderPrefs().environment).toBe(ENVIRONMENTS_LIST[1]!.id);
    expect(tiles[1]!.attributes("aria-selected")).toBe("true");
    await key(tiles[1]!.element, "ArrowRight");
    await key(tiles[2]!.element, "Enter");
    expect(renderPrefs().environment).toBe(ENVIRONMENTS_LIST[2]!.id);
    w.unmount();
  });

  it("renames the focused saved tile on F2 and gives focus back to it on Escape", async () => {
    const { w, calls } = await mountSaved();
    const tiles = w.findAll<HTMLElement>("[data-saved-environment]");
    expect(w.get('[role="listbox"][aria-label="Saved environments"]').findAll('[role="option"]')).toHaveLength(2);
    tiles[0]!.element.focus();
    await key(tiles[0]!.element, "ArrowRight");
    await key(tiles[1]!.element, "F2");
    const input = w.get<HTMLInputElement>(".rd-name input");
    expect({ focused: document.activeElement === input.element, text: input.element.value }).toEqual({
      focused: true,
      text: "Beta",
    });
    await input.trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect({ calls, back: document.activeElement === tiles[1]!.element }).toEqual({ calls: [], back: true });
    w.unmount();
  });

  it("deletes the focused saved tile on Delete without the window's own Delete seeing it", async () => {
    const { w, calls } = await mountSaved();
    const windowKeys: string[] = [];
    const spy = (e: KeyboardEvent) => windowKeys.push(e.key);
    window.addEventListener("keydown", spy);
    const beta = w.get<HTMLElement>('[data-saved-environment="Beta"]');
    beta.element.focus();
    await key(beta.element, "Delete");
    window.removeEventListener("keydown", spy);
    expect({ calls, windowKeys }).toEqual({ calls: ["remove b"], windowKeys: [] });
    w.unmount();
  });

  it("offers Rename and Delete in the button row only for the saved environment in use", async () => {
    const { w, calls } = await mountSaved();
    expect(w.find("[data-rename]").exists()).toBe(false);
    await w.get('[data-saved-environment="Beta"]').trigger("click");
    await flushPromises();
    expect(w.get('[data-saved-environment="Beta"]').attributes("aria-selected")).toBe("true");
    expect(w.get('[role="group"][aria-label="Your environments"]').find('[data-delete="Beta"]').exists()).toBe(true);
    await w.get('[data-delete="Beta"]').trigger("click");
    await flushPromises();
    expect(calls).toEqual(["remove b"]);
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

  it("offers the high quality denoise download as a small button beside the dock's other actions", async () => {
    denoiserState.info = { active: "filter", version: "", offered: true, bytes: 40_000_000 };
    const w = mountEnv();
    await flushPromises();
    expect(w.get("[data-denoiser-download]").classes()).toEqual(["btn", "btn-secondary", "btn-sm"]);
    denoiserState.info = null;
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
