// The hidden unit word of a number box follows the language, on a DOM box and on the Stress force field.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import StressPanel from "../../../src/components/overlays/StressPanel.vue";
import { uiNumberInput } from "../../../src/components/ui/dom";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { setLanguage } from "../../../src/i18n";
import { resetA11yPrefs, setA11yPref } from "../../../src/ui/a11yPrefs";
import { usePanelsStore } from "../../../src/stores/panels";
import { newLoad } from "../../../src/ui/stress";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));
afterEach(async () => {
  resetA11yPrefs();
  await setLanguage("system");
  document.body.replaceChildren();
});

const wordOf = (f: ReturnType<typeof uiNumberInput>) =>
  f.root.querySelector(`#${f.input.getAttribute("aria-describedby")}`)?.textContent;

describe("a DOM number box says its unit in the chosen language", () => {
  it("follows a switch for a shown box and for one not on the page yet, and a measure keeps its words", async () => {
    const force = uiNumberInput({ tip: "Force", unit: "N" });
    document.body.append(force.root);
    const stress = uiNumberInput({ tip: "Stress", unit: "MPa" });
    const width = uiNumberInput({ tip: "Width", unit: "mm" });
    const said = () => [force, stress, width].map(wordOf);
    expect(said()).toEqual(["newtons", "megapascals", "millimetres"]);
    await setLanguage("de");
    expect(said()).toEqual(["Newton", "Megapascal", "millimetres"]);
    await setLanguage("ja");
    expect(said()).toEqual(["ニュートン", "メガパスカル", "millimetres"]);
    const late = uiNumberInput({ tip: "Density", unit: "g/cm³" });
    expect(wordOf(late)).toBe("グラム毎立方センチメートル");
    await setLanguage("en");
    expect([...said(), wordOf(late)]).toEqual(["newtons", "megapascals", "millimetres", "grams per cubic centimetre"]);
  });

  it("with units not spoken in full the symbol stays through a switch", async () => {
    setA11yPref("unitsInFull", false);
    const force = uiNumberInput({ tip: "Force", unit: "N" });
    await setLanguage("fr");
    expect(wordOf(force)).toBe("N");
    setA11yPref("unitsInFull", true);
    expect(wordOf(force)).toBe("newtons");
  });
});

describe("the Stress force field says its unit in the chosen language", () => {
  it("reads Newton under de and newtons again under en, in a panel mounted once", async () => {
    const panels = {
      stressBodies: () => [{ id: "b1", name: "Bracket" }],
      setStressBody: vi.fn(),
      runStress: vi.fn(),
      cancelStress: vi.fn(),
      closeStress: vi.fn(),
    };
    const store = { onBuild: (fn: () => void) => (fn(), () => {}) };
    const engine = { store, ui: { panels } } as unknown as Engine;
    mount(StressPanel, { global: { provide: { [ENGINE as symbol]: engine } }, attachTo: document.body });
    const p = usePanelsStore();
    p.showStress("b1");
    await flushPromises();
    p.stress!.setup.loads.push({ ...newLoad(1), kind: "force", force: 37.5 });
    await flushPromises();
    const word = () => {
      const input = document.body.querySelector(".stress-force input")!;
      return document.getElementById(input.getAttribute("aria-describedby")!.split(" ")[0]!)?.textContent;
    };
    expect(word()).toBe("newtons");
    await setLanguage("de");
    await flushPromises();
    expect(word()).toBe("Newton");
    await setLanguage("en");
    await flushPromises();
    expect(word()).toBe("newtons");
  });
});
