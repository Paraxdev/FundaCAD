// The safety factor row is marked as yielding by its label, so the mark survives a language that renames it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import StressPanel from "../../../src/components/overlays/StressPanel.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { setLanguage } from "../../../src/i18n";
import type { StressReply } from "../../../src/geometry/client";
import { usePanelsStore } from "../../../src/stores/panels";
import { formatStressResult } from "../../../src/ui/stress";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => setLanguage("system"));

const engine = {
  store: {
    onBuild: (fn: () => void) => {
      fn();
      return () => {};
    },
  },
  ui: {
    panels: {
      stressBodies: () => [{ id: "b1", name: "Bracket" }],
      setStressColours: vi.fn(),
      lookAtStressPoint: vi.fn(),
    },
  },
} as unknown as Engine;

const reply = (safetyFactor: number): StressReply => ({
  body: "b1",
  name: "Hook",
  material: { name: "PETG", E: 2100, nu: 0.38, yield: 50 },
  mesh: { nodes: 1300, elements: 5200, size: 2.2, minDihedral: 9.6 },
  maxVonMises: { value: 18.4, at: [3, -2, 9], face: 6 },
  maxDisplacement: { value: 0.62, at: [14, 5.5, -1], vector: [0.1, -0.2, -0.58] },
  safetyFactor,
  applied: [0, -12.5, -20],
  reaction: [0, 12.5, 20],
});

async function show(safetyFactor: number) {
  mount(StressPanel, { global: { provide: { [ENGINE as symbol]: engine } }, attachTo: document.body });
  const p = usePanelsStore();
  p.showStress("b1");
  p.stressStarted();
  p.stressFinished({ result: formatStressResult(reply(safetyFactor), "mm", ["fixed"]) });
  p.setStressColours("shown");
  await flushPromises();
}

const marked = () =>
  [...document.body.querySelectorAll(".stress-key-row")].map((r) => [
    r.querySelector(".measure-k")?.textContent,
    r.querySelector(".measure-v")?.classList.contains("stress-yields"),
  ]);

describe("the yield mark on the safety factor row", () => {
  it("marks the row of a part that yields, in German and again after a switch to Japanese", async () => {
    await setLanguage("de");
    await show(0.8);
    expect(marked()).toEqual([
      ["Sicherheitsfaktor", true],
      ["Spitzenspannung", false],
      ["Max. Durchbiegung", false],
    ]);
    await setLanguage("ja");
    await flushPromises();
    expect(marked()).toEqual([
      ["安全率", true],
      ["最大応力", false],
      ["最大たわみ", false],
    ]);
  });

  it("marks nothing for a part that holds, at 1 and above", async () => {
    await setLanguage("de");
    await show(1);
    expect(marked().map((r) => r[1])).toEqual([false, false, false]);
  });
});
