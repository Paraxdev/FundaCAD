// The Navigation settings, their option lists and the radial conflict follow the chosen language, a switch included.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import NavigationSection from "../../plugins/FundaCAD.Navigation/NavigationSection.vue";
import {
  DEFAULT_CONFIG,
  PRESETS,
  RADIAL_CONTEXTS,
  RADIAL_DRAGS,
  SETTINGS,
  bindingRows,
  tableFor,
} from "../../plugins/FundaCAD.Navigation/navigation";
import { navState } from "../../plugins/FundaCAD.Navigation/state";
import { setLanguage } from "../../src/i18n";
import { byName, nameOf, stubResizeObserver } from "./pluginA11y";

enableAutoUnmount(afterEach);

beforeEach(() => {
  document.body.innerHTML = "";
  stubResizeObserver(vi.stubGlobal);
  navState.cfg = { ...structuredClone(DEFAULT_CONFIG), radial: true };
  navState.problem = null;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await setLanguage("system");
});

const open = async () => {
  const w = mount(NavigationSection, { attachTo: document.body });
  await flushPromises();
  return w;
};

const keyButtons = () =>
  [...document.querySelectorAll<HTMLElement>("button")].filter((b) =>
    /, (shortcut|Tastenkürzel|ショートカット) /.test(nameOf(b)),
  );

describe("the Navigation settings", () => {
  it("read in German, then in Japanese, without a remount", async () => {
    await setLanguage("de");
    const w = await open();
    const groups = [...document.querySelectorAll("details [role=group]")].map(nameOf);
    expect(groups).toEqual(["Nichts ausgewählt", "Etwas ausgewählt", "In einer Skizze"]);
    const names = [...document.querySelectorAll("[role=combobox]")].map((c) => nameOf(c).split(",")[0]);
    expect(names[0]).toBe("Platz 1");
    expect(names.at(-1)).toBe("Mehr 2");
    const list = document.querySelector("[role=list]")!;
    expect(nameOf(list)).toBe("Tastenkürzel");
    expect(nameOf(keyButtons()[0]!)).toMatch(/^.+, Tastenkürzel .+, ändern$/);
    expect(byName(document.body, "button", "Alle Tasten zurücksetzen")).toBeDefined();
    expect(w.text()).toContain("Rechts ziehen: drehen.");

    await setLanguage("ja");
    await flushPromises();
    expect([...document.querySelectorAll("details [role=group]")].map(nameOf)).toEqual([
      "何も選択していない",
      "何かを選択している",
      "スケッチ内",
    ]);
    expect(nameOf(document.querySelector("[role=list]")!)).toBe("ショートカットキー");
    expect(byName(document.body, "button", "すべてのキーをリセット")).toBeDefined();
    expect(w.text()).toContain("右ドラッグ：オービット。");
  });

  it("say a refused key in the chosen language", async () => {
    await setLanguage("de");
    await open();
    const first = keyButtons()[0]!;
    const label = nameOf(first).split(", Tastenkürzel")[0]!;
    first.click();
    await flushPromises();
    expect(nameOf(first)).toBe(`Neues Tastenkürzel für ${label} drücken`);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    await flushPromises();
    expect(document.querySelector("[role=alert]")!.textContent).toMatch(/^Fehler: /);
  });

  it("say a radial conflict as a warning, worded again after a switch", async () => {
    navState.cfg = { ...structuredClone(DEFAULT_CONFIG), radial: true, radialDrag: "right" };
    await setLanguage("de");
    await open();
    expect(document.querySelector("[role=alert]")!.textContent).toBe(
      "Warnung: Rechts ziehen belegt in dieser Voreinstellung schon das Drehen, daher liegt das Radialmenü nur auf seiner Taste",
    );
    await setLanguage("ja");
    await flushPromises();
    expect(document.querySelector("[role=alert]")!.textContent).toContain("右ドラッグはすでに回転に使われている");
  });
});

describe("the lists and settings read the language when asked", () => {
  it("rename presets, triggers, contexts and setting labels after a switch", async () => {
    await setLanguage("de");
    expect(PRESETS.map((p) => p.label)).toContain("Rechts dreht (Standard)");
    expect(RADIAL_DRAGS.map((d) => d.label)).toContain("Kein Mausauslöser, nur die Taste");
    expect(RADIAL_CONTEXTS.map((c) => c.label)).toEqual(["Nichts ausgewählt", "Etwas ausgewählt", "In einer Skizze"]);
    const preset = SETTINGS.props.find((p) => p.key === "preset") as unknown as { label: string };
    expect(preset.label).toBe("Maustasten");
    expect(tableFor({ ...DEFAULT_CONFIG, radial: true, radialDrag: "right" }).problem).toContain(
      "Rechts ziehen belegt",
    );
    expect(bindingRows(tableFor(DEFAULT_CONFIG).table)).toContainEqual({ key: "Rechts ziehen", label: "drehen" });
    await setLanguage("ja");
    expect(PRESETS[0]!.label).toBe("右ボタンで回転(既定)");
    expect(preset.label).toBe("マウスボタン");
    await setLanguage("en");
    expect(PRESETS[0]!.label).toBe("Right orbits (default)");
    expect(bindingRows(tableFor(DEFAULT_CONFIG).table)).toContainEqual({ key: "Right drag", label: "orbit" });
  });
});
