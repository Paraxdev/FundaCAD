// The Printed look section for a screen reader: the switch, both sliders and the direction choice are named base
// controls, and the layer height says its unit.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import LayerLinesSection from "../../plugins/FundaCAD.PrintLook/LayerLinesSection.vue";
import { settings } from "../../plugins/FundaCAD.PrintLook/settings";
import { DIRECTIONS } from "../../plugins/FundaCAD.PrintLook/look";
import { byName, nameOf, rawControls, stubResizeObserver, unnamed } from "./pluginA11y";

enableAutoUnmount(afterEach);

beforeEach(() => {
  document.body.innerHTML = "";
  stubResizeObserver(vi.stubGlobal);
});
afterEach(() => {
  settings.reset();
  vi.unstubAllGlobals();
});

async function open(layerLines: boolean) {
  settings.set("layerLines", layerLines);
  mount(LayerLinesSection, { attachTo: document.body });
  await flushPromises();
  return document.body;
}

describe("the Printed look section, for a screen reader", () => {
  it("shows only the named Layer lines switch while the lines are off", async () => {
    const root = await open(false);
    expect(rawControls(root)).toEqual([]);
    expect(unnamed(root)).toEqual([]);
    expect(root.querySelectorAll("input")).toHaveLength(1);
    expect(nameOf(root.querySelector("input")!)).toBe("Layer lines");
  });

  it("names every control once the lines are on, with no raw control", async () => {
    const root = await open(true);
    expect(rawControls(root)).toEqual([]);
    expect(unnamed(root)).toEqual([]);
    expect(byName(root, "input[type=range]", "Layer height")).toBeDefined();
    expect(byName(root, "input[type=range]", "Depth")).toBeDefined();
  });

  it("says the layer height in millimetres", async () => {
    const root = await open(true);
    const height = byName<HTMLInputElement>(root, "input[type=range]", "Layer height")!;
    expect(height.getAttribute("aria-valuetext")).toBe("0.2 mm");
  });

  it("draws the direction as one named group with a radio per axis", async () => {
    const root = await open(true);
    const group = [...root.querySelectorAll("[role=radiogroup]")].find((g) => nameOf(g) === "Direction")!;
    expect(group).toBeDefined();
    expect([...group.querySelectorAll("[role=radio]")].map(nameOf)).toEqual(DIRECTIONS.map((d) => d.label));
  });
});
