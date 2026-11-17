// The Game controller panel, its button names and its settings follow the chosen language, a switch included.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import GamepadSection from "../../plugins/FundaCAD.Gamepad/GamepadSection.vue";
import { BUTTON_LABELS, KEY_CHOICES, SETTINGS } from "../../plugins/FundaCAD.Gamepad/gamepad";
import { padState } from "../../plugins/FundaCAD.Gamepad/state";
import { setLanguage } from "../../src/i18n";
import { nameOf, stubResizeObserver } from "./pluginA11y";

enableAutoUnmount(afterEach);

beforeEach(() => {
  document.body.innerHTML = "";
  stubResizeObserver(vi.stubGlobal);
});
afterEach(async () => {
  padState.name = null;
  vi.unstubAllGlobals();
  await setLanguage("system");
});

const prop = (key: string) => SETTINGS.props.find((p) => p.key === key) as unknown as Record<string, string>;
const comboNames = () => [...document.querySelectorAll("[role=combobox]")].map((el) => nameOf(el).split(",")[0]);

describe("the Game controller panel", () => {
  it("reads in German, then in Japanese, without a remount", async () => {
    await setLanguage("de");
    const w = mount(GamepadSection, { attachTo: document.body });
    await flushPromises();
    expect(w.text()).toContain("Noch kein Controller erkannt");
    expect(nameOf(document.querySelector("[role=group]")!)).toBe("Tasten");
    expect(comboNames()).toContain("Steuerkreuz oben");
    expect(comboNames()).toContain("A");

    padState.name = "Xbox Wireless Controller";
    await nextTick();
    expect(w.find("b").text()).toBe("Xbox Wireless Controller");
    expect(w.find(".pref-hint").text()).toContain("wird gelesen.");

    await setLanguage("ja");
    await nextTick();
    expect(nameOf(document.querySelector("[role=group]")!)).toBe("ボタン");
    expect(w.find(".pref-hint").text()).toContain("を読み取っています。");
    expect(comboNames()).toContain("十字キー上");
  });

  it("offers its choices in the chosen language and keeps the key names it prints", async () => {
    await setLanguage("fr");
    mount(GamepadSection, { attachTo: document.body });
    await flushPromises();
    document.querySelector<HTMLElement>("[role=combobox]")!.click();
    await flushPromises();
    const options = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? "");
    expect(options[0]).toMatch(/Rien/);
    expect(options[1]).toMatch(/Curseur activé \/ désactivé/);
    expect(options.find((o) => /Entrée \(valider\)/.test(o))).toMatch(/Touches/);
    expect(options.find((o) => /Delete/.test(o))).toBeDefined();
  });
});

describe("the lists and settings read the language when asked", () => {
  it("rename button labels, key choices and setting labels after a switch", async () => {
    await setLanguage("de");
    expect([BUTTON_LABELS[12], BUTTON_LABELS[10], BUTTON_LABELS[0], BUTTON_LABELS[8]]).toEqual([
      "Steuerkreuz oben",
      "Linken Stick drücken",
      "A",
      "View / Back",
    ]);
    expect(KEY_CHOICES.map((k) => k.label)).toEqual([
      "Enter (bestätigen)",
      "Escape (abbrechen)",
      "Delete",
      "Tab",
      "Befehlspalette",
    ]);
    expect(prop("panSens").label).toBe("Verschiebegeschwindigkeit");
    expect(prop("deadzone").group).toBe("Sticks");
    await setLanguage("ja");
    expect(BUTTON_LABELS[12]).toBe("十字キー上");
    expect(prop("panSens").label).toBe("パン速度");
    expect(prop("deadzone").group).toBe("スティック");
    expect(prop("cursorSpeed").unit).toBe("px/s");
    await setLanguage("en");
    expect(BUTTON_LABELS[12]).toBe("D-pad up");
    expect(prop("panSens").label).toBe("Pan speed");
  });
});
