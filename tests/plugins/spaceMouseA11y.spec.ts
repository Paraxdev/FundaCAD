// The 3D mouse settings for a screen reader, drawn with the device stubbed: no HID device, no Tauri and no WebGL are
// reached. Every mapping is a named select and a named flip box in one Axis mapping group, the live graphics say they
// are graphics, and the flip box changes the binding.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("three", async (importOriginal) => ({
  ...(await importOriginal<typeof import("three")>()),
  WebGLRenderer: class {
    setPixelRatio() {}
    setSize() {}
    render() {}
    forceContextLoss() {}
    dispose() {}
  },
}));

import SpaceMouseSection from "../../plugins/FundaCAD.SpaceMouse/SpaceMouseSection.vue";
import { ACTION_LABELS, AXIS_NAMES, getSpaceMouseConfig, settings } from "../../plugins/FundaCAD.SpaceMouse/spacemouse";
import { nameOf, rawControls, stubResizeObserver, unnamed } from "./pluginA11y";

enableAutoUnmount(afterEach);

beforeEach(() => {
  document.body.innerHTML = "";
  stubResizeObserver(vi.stubGlobal);
});
afterEach(() => {
  settings.reset();
  vi.unstubAllGlobals();
});

async function open() {
  mount(SpaceMouseSection, { attachTo: document.body });
  await flushPromises();
  return document.body;
}

const combos = (root: Element) => [...root.querySelectorAll<HTMLElement>("[role=combobox]")];
const flips = (root: Element) => [...root.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];

describe("the 3D mouse settings, for a screen reader", () => {
  it("names every control and draws no raw control", async () => {
    const root = await open();
    expect(rawControls(root)).toEqual([]);
    expect(unnamed(root)).toEqual([]);
  });

  it("draws each action as a named select and a flip box that names its action", async () => {
    const root = await open();
    const labels = Object.values(ACTION_LABELS);
    expect(combos(root).map((el) => nameOf(el).split(",")[0])).toEqual(labels);
    expect(flips(root).map(nameOf)).toEqual(labels.map((l) => `flip ${l}`));
  });

  it("keeps the mapping in one group named Axis mapping", async () => {
    const root = await open();
    const group = [...root.querySelectorAll("[role=group]")].find((g) => nameOf(g) === "Axis mapping")!;
    expect(group).toBeDefined();
    expect(group.querySelectorAll("[role=combobox]")).toHaveLength(Object.keys(ACTION_LABELS).length);
    expect(group.querySelectorAll("input[type=checkbox]")).toHaveLength(Object.keys(ACTION_LABELS).length);
  });

  it("names the test cube and leaves the rate-driven axis bars out of the reading order", async () => {
    const root = await open();
    const canvas = root.querySelector("canvas")!;
    expect(canvas.getAttribute("role")).toBe("img");
    expect(nameOf(canvas)).toMatch(/^Test cube/);
    const rows = [...root.querySelectorAll(".sm-axis-row")];
    expect(rows).toHaveLength(AXIS_NAMES.length);
    for (const row of rows) expect(row.getAttribute("aria-hidden")).toBe("true");
  });

  it("flips the binding from its box", async () => {
    const root = await open();
    const before = getSpaceMouseConfig().bind.panX.invert;
    flips(root)[0]!.click();
    await flushPromises();
    expect(getSpaceMouseConfig().bind.panX.invert).toBe(!before);
  });

  it("rebinds an action from its select", async () => {
    const root = await open();
    combos(root)[0]!.click();
    await flushPromises();
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
      /Twist/.test(o.textContent ?? ""),
    )!;
    option.click();
    await flushPromises();
    expect(getSpaceMouseConfig().bind.panX.src).toBe("rz");
  });
});
