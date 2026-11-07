// The Gamepad settings draw with the base controls: every button binding is a named combobox, its options say the
// group they come from, and the bindings are one named group.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import GamepadSection from "../../plugins/FundaCAD.Gamepad/GamepadSection.vue";
import { BINDABLE, BUTTON_LABELS, getGamepadConfig } from "../../plugins/FundaCAD.Gamepad/gamepad";
import { nameOf, rawControls, stubResizeObserver, unnamed } from "./pluginA11y";

enableAutoUnmount(afterEach);

beforeEach(() => {
  document.body.innerHTML = "";
  stubResizeObserver(vi.stubGlobal);
});
afterEach(() => vi.unstubAllGlobals());

async function open() {
  mount(GamepadSection, { attachTo: document.body });
  await flushPromises();
  return document.body;
}

const combos = (root: Element) => [...root.querySelectorAll<HTMLElement>("[role=combobox]")];

describe("the Gamepad settings, for a screen reader", () => {
  it("names every control and draws no raw select", async () => {
    const root = await open();
    expect(rawControls(root)).toEqual([]);
    expect(unnamed(root)).toEqual([]);
    expect(combos(root).map((el) => nameOf(el).split(",")[0])).toEqual(BINDABLE.map((i) => BUTTON_LABELS[i]));
  });

  it("keeps the bindings in one group named Buttons", async () => {
    const root = await open();
    const group = root.querySelector("[role=group]")!;
    expect(group).not.toBeNull();
    expect(nameOf(group)).toBe("Buttons");
    expect(group.querySelectorAll("[role=combobox]")).toHaveLength(BINDABLE.length);
  });

  it("offers Nothing, the cursor and the keys, each key naming its group", async () => {
    const root = await open();
    combos(root)[0]!.click();
    await flushPromises();
    const options = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? "");
    expect(options[0]).toMatch(/Nothing/);
    expect(options[1]).toMatch(/Cursor on \/ off/);
    expect(options.find((o) => /Enter \(confirm\)/.test(o))).toMatch(/Keys/);
  });

  it("binds the picked choice", async () => {
    const root = await open();
    const first = BINDABLE[0]!;
    combos(root)[0]!.click();
    await flushPromises();
    const nothing = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
      /Nothing/.test(o.textContent ?? ""),
    )!;
    nothing.click();
    await flushPromises();
    expect(getGamepadConfig().buttons[first] ?? "").toBe("");
  });
});
