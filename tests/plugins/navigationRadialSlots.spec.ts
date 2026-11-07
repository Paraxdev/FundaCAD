// A radial slot shows the name of what it runs: a shipped default that is a keyboard action and no palette command
// still reads as its key's name, and an id nothing knows reads as not available, never as the raw id.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import NavigationSection from "../../plugins/FundaCAD.Navigation/NavigationSection.vue";
import { DEFAULT_CONFIG, RADIAL_CONTEXTS } from "../../plugins/FundaCAD.Navigation/navigation";
import { navState } from "../../plugins/FundaCAD.Navigation/state";
import { stubResizeObserver } from "./pluginA11y";

enableAutoUnmount(afterEach);

beforeEach(() => {
  document.body.innerHTML = "";
  stubResizeObserver(vi.stubGlobal);
  navState.cfg = { ...structuredClone(DEFAULT_CONFIG), radial: true };
  navState.problem = null;
});
afterEach(() => vi.unstubAllGlobals());

async function slots() {
  mount(NavigationSection, { attachTo: document.body });
  await flushPromises();
  return [...document.querySelectorAll<HTMLElement>("details [role=combobox]")].map((c) => ({
    id: c.dataset.value ?? "",
    shown: c.querySelector(".select-value")?.textContent?.trim() ?? "",
  }));
}

function slotOf(all: { id: string; shown: string }[], ctx: string, slot: number) {
  const i = RADIAL_CONTEXTS.findIndex((c) => c.id === ctx);
  return all[i * (all.length / RADIAL_CONTEXTS.length) + slot - 1];
}

describe("the Navigation radial slots", () => {
  it("never shows a default slot's raw id", async () => {
    const raw = (await slots()).filter((s) => s.id && s.shown === s.id);
    expect(raw).toEqual([]);
  });

  it("names the wireframe and hide defaults by their keys' names", async () => {
    const all = await slots();
    expect(slotOf(all, "model", 7)).toEqual({ id: "toggle-wireframe", shown: "Wireframe (edges only)" });
    expect(slotOf(all, "selection", 6)).toEqual({ id: "hide-selected", shown: "Hide selected bodies" });
  });

  it("shows a slot whose id nothing knows as not available", async () => {
    navState.cfg.items.model[0] = "gone-plugin-command";
    expect(slotOf(await slots(), "model", 1)).toEqual({ id: "gone-plugin-command", shown: "Not available" });
  });
});
