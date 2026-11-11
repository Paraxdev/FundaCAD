// The Stress undo and redo labels read in the picked language, also for a step noted before a switch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { setLanguage } from "../../src/i18n";
import { usePanelsStore } from "../../src/stores/panels";
import { useToastStore } from "../../src/stores/toasts";
import { newLoad, newSetup, newSupport, type StressFaceSet, type StressSetup } from "../../src/ui/stress";
import { MERGE_MS, StressHistory, describeStressChange } from "../../src/ui/stressHistory";
import { englishLeft } from "../i18n/englishLeft";
import { rig } from "./stressPanelRig";

vi.stubGlobal("window", globalThis);
vi.mock("../../src/ui/announce", () => ({ announce: () => {} }));

beforeEach(() => setActivePinia(createPinia()));
afterEach(async () => {
  await setLanguage("system");
});

const faces = (point: number): StressFaceSet => ({
  selectors: [{ kind: "face", by: "nearest", point: [point, 2, -1], body: "b1" }],
  faceIds: [7],
  normalSum: [0, 0, 1],
  area: 2,
});
const copy = (s: StressSetup): StressSetup => JSON.parse(JSON.stringify(s)) as StressSetup;
function edit(s: StressSetup, change: (s: StressSetup) => void): StressSetup {
  const next = copy(s);
  change(next);
  return next;
}

// Ids off the row numbers, so a number in a label is the row, never the id.
const base = (() => {
  const s = newSetup("b1");
  s.supports = [newSupport(4), newSupport(9)];
  s.loads = [newLoad(5), newLoad(8), newLoad(11)];
  s.supports[1]!.spots = [
    { at: [3, 1, 2], radius: 2 },
    { at: [4, -2, 6], radius: 3 },
  ];
  return s;
})();

const cases: [string, (s: StressSetup) => void, string[]][] = [
  ["body", (s) => (s.body = "b2"), []],
  ["support added", (s) => s.supports.push(newSupport(12)), []],
  ["support removed", (s) => s.supports.splice(1, 1), ["2"]],
  ["supports reordered", (s) => s.supports.reverse(), []],
  ["support type", (s) => (s.supports[1]!.type = "pinned"), ["2"]],
  ["support faces", (s) => (s.supports[1]!.faces = faces(3)), ["2"]],
  ["support spots", (s) => (s.supports[1]!.spots = [{ at: [3, 1, 2], radius: 2 }]), ["2"]],
  ["support spot radius", (s) => (s.supports[1]!.spots![1]!.radius = 5), ["2", "2"]],
  [
    "support faces and spots",
    (s) => {
      s.supports[1]!.faces = faces(3);
      s.supports[1]!.spots = [];
    },
    ["2"],
  ],
  ["load added", (s) => s.loads.push(newLoad(14)), []],
  ["load removed", (s) => s.loads.splice(2, 1), ["3"]],
  ["loads reordered", (s) => s.loads.reverse(), []],
  ["load kind", (s) => (s.loads[2]!.kind = "pressure"), ["3"]],
  ["load faces", (s) => (s.loads[1]!.faces = faces(5)), ["2"]],
  ["load force", (s) => (s.loads[2]!.force = 250), ["3"]],
  ["load direction", (s) => (s.loads[1]!.direction = "-Z"), ["2"]],
  ["load custom vector", (s) => (s.loads[1]!.custom = [1, 2, 5]), ["2"]],
  ["load pressure", (s) => (s.loads[2]!.pressure = 3), ["3"]],
  ["own weight", (s) => (s.gravity.direction = "+X"), []],
  ["material", (s) => (s.material = "steel"), []],
  ["custom material", (s) => (s.custom.E = 1234), []],
  ["mesh detail", (s) => (s.refine = "off"), []],
];

// Words one language shares with English.
const COGNATES = ["radius", "material", "type", "faces", "force", "direction"];

const labelOf = (name: string) => describeStressChange(base, edit(base, cases.find((c) => c[0] === name)![1])).label;

async function labelsUnder(lang: string): Promise<string[]> {
  await setLanguage(lang as never);
  return cases.map(([, change]) => describeStressChange(base, edit(base, change)).label);
}

describe("Stress undo labels in each language", () => {
  it("names every kind of step in the language, keeping the row numbers", async () => {
    const english = await labelsUnder("en");
    for (const lang of ["de", "fr", "es", "zh-CN", "ja"]) {
      const labels = await labelsUnder(lang);
      labels.forEach((label, i) => {
        const [what, , numbers] = cases[i]!;
        // Material is the same word in German and Spanish.
        const cognate = /material/.test(what) && (lang === "de" || lang === "es");
        if (!cognate) expect(label, `${lang} ${what}`).not.toBe(english[i]);
        expect(englishLeft(label, english[i]!, COGNATES), `${lang} ${what} keeps English words`).toEqual([]);
        expect(label.match(/\d+/g) ?? [], `${lang} ${what} numbers`).toEqual(numbers);
      });
    }
  });

  it("reads German for the rows a person sees", async () => {
    await setLanguage("de");
    expect(labelOf("load force")).toBe("Last 3 Kraft");
    expect(labelOf("support faces")).toBe("Halterung 2 Flächen");
    expect(labelOf("support spot radius")).toBe("Halterung 2 Stelle 2 Radius");
    expect(labelOf("load added")).toBe("Last hinzufügen");
  });

  it("keeps English when the language is English", async () => {
    await setLanguage("en");
    expect([labelOf("load force"), labelOf("support spot radius"), labelOf("support removed")]).toEqual([
      "Load 3 force",
      "Support 2 spot 2 radius",
      "Remove support 2",
    ]);
  });
});

describe("a step read late", () => {
  it("noted in English reads German once the language switches, and back", async () => {
    await setLanguage("en");
    const h = new StressHistory();
    h.reset(base);
    const forced = edit(base, (s) => (s.loads[1]!.force = 77));
    h.note(forced, 1000);
    expect(h.undoLabel).toBe("Load 2 force");
    await setLanguage("de");
    expect(h.undoLabel).toBe("Last 2 Kraft");
    const undone = h.undo(forced, 1000);
    expect(undone!.label).toBe("Last 2 Kraft");
    expect(h.redoLabel).toBe("Last 2 Kraft");
    await setLanguage("en");
    expect(h.redoLabel).toBe("Load 2 force");
  });

  it("merges two force drags of one load under German, also across a switch", async () => {
    await setLanguage("de");
    const h = new StressHistory();
    h.reset(base);
    const at = (force: number) => edit(base, (s) => (s.loads[1]!.force = force));
    h.note(at(10), 1000);
    h.note(at(20), 1000 + MERGE_MS - 1);
    await setLanguage("fr");
    h.note(at(35), 1000 + MERGE_MS + 40);
    expect(h.undo(at(35), 5000)!.setup.loads[1]!.force, "one step back to the start").toBe(base.loads[1]!.force);
    expect(h.canUndo).toBe(false);
  });

  it("does not merge across the window, nor two loads, nor a force and a pressure", async () => {
    await setLanguage("de");
    const h = new StressHistory();
    h.reset(base);
    const s1 = edit(base, (s) => (s.loads[1]!.force = 10));
    const s2 = edit(s1, (s) => (s.loads[1]!.force = 20));
    const s3 = edit(s2, (s) => (s.loads[2]!.force = 30));
    const s4 = edit(s3, (s) => (s.loads[2]!.pressure = 4));
    const s5 = edit(s4, (s) => (s.loads[2]!.pressure = 6));
    h.note(s1, 1000);
    h.note(s2, 1000 + MERGE_MS + 1);
    h.note(s3, 1000 + MERGE_MS + 2);
    h.note(s4, 1000 + MERGE_MS + 3);
    h.note(s5, 1000 + MERGE_MS + 4);
    const seen: (string | null)[] = [];
    let cur = s5;
    for (let i = 0; i < 6; i++) {
      seen.push(h.undoLabel);
      const step = h.undo(cur, 9000);
      if (!step) break;
      cur = step.setup;
    }
    expect(seen).toEqual(["Last 3 Druck", "Last 3 Kraft", "Last 2 Kraft", "Last 2 Kraft", null]);
  });

  it("a reset for a second setup leaves no label of the first", async () => {
    await setLanguage("de");
    const h = new StressHistory();
    h.reset(base);
    const forced = edit(base, (s) => (s.loads[0]!.force = 5));
    h.note(forced, 1000);
    h.undo(forced, 2000);
    expect([h.undoLabel, h.redoLabel]).toEqual([null, "Last 1 Kraft"]);
    const other = edit(newSetup("b2"), (s) => s.supports.push(newSupport(30)));
    h.reset(other);
    expect([h.canUndo, h.canRedo, h.undoLabel, h.redoLabel]).toEqual([false, false, null, null]);
    h.note(
      edit(other, (s) => (s.supports[1]!.type = "slider")),
      3000,
    );
    expect([h.undoLabel, h.redoLabel]).toEqual(["Art von Halterung 2", null]);
  });
});

describe("the panel's undo tip and toast", () => {
  it("shows the toast and title bar tip in German, and a switch rewrites the tip", async () => {
    await setLanguage("de");
    const r = rig();
    r.ui.showStress();
    r.ui.setStressBody("b1");
    await nextTick();
    const d = usePanelsStore().stress!;
    d.setup.loads[0]!.force = 321;
    await nextTick();
    expect(d.undoLabel).toBe("Last 1 Kraft");
    expect(r.ui.undoStress()).toBe(true);
    expect(useToastStore().items.at(-1)?.message).toBe("Rückgängig: Last 1 Kraft");
    expect(d.redoLabel).toBe("Last 1 Kraft");
    await setLanguage("fr");
    expect(d.redoLabel).toBe("Force de la charge 1");
    await setLanguage("en");
    expect([d.undoLabel, d.redoLabel]).toEqual(["Body", "Load 1 force"]);
    expect(r.ui.redoStress()).toBe(true);
    expect(useToastStore().items.at(-1)?.message).toBe("Redid: Load 1 force");
  });
});
