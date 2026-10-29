// The Overhang panel: the app's Select and slider, a legend for every colour the viewport paints.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import OverhangPanel from "../../../src/components/overlays/OverhangPanel.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { usePanelsStore } from "../../../src/stores/panels";
import { DRAFT_COLORS } from "../../../src/viewport/draftColors";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));

const q = (sel: string) => document.body.querySelector<HTMLElement>(sel);

async function mounted() {
  const configs: [string, number][] = [];
  const engine = {
    viewport: {
      draftConfig: { dir: "-Y", threshold: 38 },
      setDraftConfig: (dir: string, threshold: number) => configs.push([dir, threshold]),
    },
  } as unknown as Engine;
  mount(OverhangPanel, { global: { provide: { [ENGINE as symbol]: engine } }, attachTo: document.body });
  usePanelsStore().overhang = true;
  await flushPromises();
  return configs;
}

describe("OverhangPanel", () => {
  it("uses the app's Select and slider, seeded from the viewport", async () => {
    await mounted();
    expect(q(".overhang-panel select")).toBeNull();
    expect(q(".overhang-panel .select-trigger")?.getAttribute("data-value")).toBe("-Y");
    const slider = q(".overhang-panel input[type=range]") as HTMLInputElement;
    expect(slider.classList.contains("ui-slider-input")).toBe(true);
    const name = document.getElementById(slider.getAttribute("aria-labelledby")!)?.textContent;
    expect([slider.value, name]).toEqual(["38", "Threshold"]);
    expect(q(".overhang-panel .ui-slider-value")?.textContent).toBe("38°");
  });

  it("keys every colour the viewport paints", async () => {
    await mounted();
    const keys = [...document.body.querySelectorAll<HTMLElement>(".overhang-key")].map((k) =>
      k.style.getPropertyValue("--key"),
    );
    const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
    expect(keys).toEqual([hex(DRAFT_COLORS.overhang), hex(DRAFT_COLORS.wall), hex(DRAFT_COLORS.top)]);
    expect(q(".overhang-panel .measure-hint")?.textContent).not.toContain("Draft");
  });

  it("sends a picked direction and a dragged threshold to the viewport", async () => {
    const configs = await mounted();
    q(".overhang-panel .select-trigger")!.click();
    await flushPromises();
    const row = [...document.body.querySelectorAll<HTMLElement>(".select-pop .opt-row")].find(
      (r) => r.querySelector(".opt-label")?.textContent === "+X",
    );
    row!.click();
    await flushPromises();
    const slider = q(".overhang-panel input[type=range]") as HTMLInputElement;
    slider.value = "57";
    slider.dispatchEvent(new Event("input"));
    await flushPromises();
    expect(configs).toEqual([
      ["+X", 38],
      ["+X", 57],
    ]);
  });
});
