// The Navigation settings for a screen reader: radial slots are named base selects in labelled groups, every key is a
// named button inside a list, and a refused key or a radial conflict is an alert that says its level in words.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import NavigationSection from "../../plugins/FundaCAD.Navigation/NavigationSection.vue";
import { DEFAULT_CONFIG, RADIAL_CONTEXTS, RING_SLOTS } from "../../plugins/FundaCAD.Navigation/navigation";
import { navState } from "../../plugins/FundaCAD.Navigation/state";
import { byName, nameOf, rawControls, stubResizeObserver, unnamed } from "./pluginA11y";

enableAutoUnmount(afterEach);

beforeEach(() => {
  document.body.innerHTML = "";
  stubResizeObserver(vi.stubGlobal);
  navState.cfg = { ...structuredClone(DEFAULT_CONFIG), radial: true };
  navState.problem = null;
});
afterEach(() => vi.unstubAllGlobals());

async function open() {
  mount(NavigationSection, { attachTo: document.body });
  await flushPromises();
  return document.body;
}

const keyButtons = (root: Element) =>
  [...root.querySelectorAll<HTMLElement>("button")].filter((b) => /, shortcut /.test(nameOf(b)));

describe("the Navigation settings, for a screen reader", () => {
  it("names every control and draws no raw control", async () => {
    const root = await open();
    expect(rawControls(root)).toEqual([]);
    expect(unnamed(root)).toEqual([]);
  });

  it("draws every radial slot as a named combobox in a group for its context", async () => {
    const root = await open();
    const combos = [...root.querySelectorAll<HTMLElement>("[role=combobox]")];
    expect(combos).toHaveLength(RADIAL_CONTEXTS.length * (RING_SLOTS + 2));
    const groups = [...root.querySelectorAll("details [role=group]")];
    expect(groups.map(nameOf)).toEqual(RADIAL_CONTEXTS.map((c) => c.label));
    for (const g of groups) {
      const names = [...g.querySelectorAll("[role=combobox]")].map((c) => nameOf(c).split(",")[0]);
      expect(names[0]).toBe("Slot 1");
      expect(names.at(-1)).toBe("More 2");
    }
  });

  it("names the cards that hold the controls", async () => {
    const root = await open();
    const names = [...root.querySelectorAll("[role=group]")].map(nameOf);
    expect(names).toContain("Radial menu items");
    expect(names).toContain("Keyboard shortcuts");
  });

  it("makes each key a named button in a list, and the reset a button that says which key", async () => {
    const root = await open();
    const list = root.querySelector("[role=list]")!;
    expect(nameOf(list)).toBe("Shortcut keys");
    const rows = list.querySelectorAll("[role=listitem]");
    expect(rows.length).toBeGreaterThan(3);
    expect(keyButtons(root)).toHaveLength(rows.length);
    expect(nameOf(keyButtons(root)[0]!)).toMatch(/^.+, shortcut .+, change$/);
    expect(byName(root, "button", "Reset all keys")).toBeDefined();
  });

  it("is pressed and renamed while it listens, and says a refused key as an error alert", async () => {
    const root = await open();
    const first = keyButtons(root)[0]!;
    const label = nameOf(first).split(", shortcut")[0]!;
    first.click();
    await flushPromises();
    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(nameOf(first)).toBe(`Press the new shortcut for ${label}`);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    await flushPromises();
    const alert = root.querySelector("[role=alert]")!;
    expect(alert.textContent).toMatch(/^Error: /);
    expect(root.querySelector("[role=status]")).toBeNull();
  });

  it("says a radial conflict as a warning alert, and no alert without one", async () => {
    let root = await open();
    expect(root.querySelector("[role=alert]")).toBeNull();
    navState.problem = "Right drag already does orbit in this preset, so the radial menu is on its key only";
    await flushPromises();
    root = document.body;
    expect(root.querySelector("[role=alert]")!.textContent).toBe(`Warning: ${navState.problem}`);
  });
});
