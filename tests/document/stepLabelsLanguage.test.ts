// Undo and Redo labels are data read late: the step is named in the language of the moment, never in the one it was taken in.
import { afterEach, describe, expect, it, vi } from "vitest";

const announce = vi.fn();
vi.mock("../../src/ui/announce", () => ({ announce: (...a: unknown[]) => announce(...a) }));
vi.mock("../../src/ui/home", () => ({ closeHome: () => {} }));
vi.mock("../../src/io/files", () => ({ openDocument: () => {} }));

import { createPinia, setActivePinia } from "pinia";
import { createDocumentActions } from "../../src/app/documentActions";
import { installTitlebar } from "../../src/app/titlebar";
import { useUiStore } from "../../src/stores/ui";
import type { Engine } from "../../src/app/engine";
import { setLanguage } from "../../src/i18n";
import de from "../../src/i18n/locales/de.json";
import en from "../../src/i18n/locales/en.json";
import fr from "../../src/i18n/locales/fr.json";
import { stepLabel, stepText, type LateStep } from "../../src/document/stepLabels";
import { box, freshStore } from "./storeKit";
import type { CadDocument, Feature } from "../../src/types";
import { englishLeft } from "../i18n/englishLeft";

vi.stubGlobal("window", globalThis);

afterEach(async () => {
  await setLanguage("system");
});

const f = (id: string, type: string, extra: object = {}) => ({ id, type, ...extra }) as unknown as Feature;
const doc = (features: Feature[], parameters: Record<string, number> = {}): CadDocument =>
  ({ parameters, features }) as unknown as CadDocument;
const copy = (d: CadDocument): CadDocument => structuredClone(d);

const a = f("a", "box", { w: 40.5, d: 22.25, h: 7 });
const b = f("b", "fillet", { radius: 1.5 });
const c = f("c", "extrude", { distance: 12.75 });
const d = f("d", "fillet", { radius: 2.25 });
const base = doc([a, b, c, d]);
const rim = (extra: object = {}) => ({ ...d, name: "Rim", ...extra }) as unknown as Feature;

const ref = (type: string, place: number | null, fixed: string | null = null) => ({
  fixed,
  meta: { type },
  place,
});

function edited(radius: number): CadDocument {
  const next = copy(base);
  (next.features[3] as unknown as { radius: number }).radius = radius;
  return next;
}

const editedTwo = (() => {
  const next = edited(3.75);
  (next.features[0] as unknown as { w: number }).w = 41;
  return next;
})();

// Each case: the document after, the data the label must be, today's English words.
const CASES: [string, CadDocument, LateStep, string][] = [
  [
    "add one",
    doc([...base.features, f("e", "fillet")]),
    { key: "step.label.named", step: ref("fillet", 3) },
    "Fillet 3",
  ],
  [
    "add three",
    doc([...base.features, f("e", "fillet"), f("g", "chamfer"), f("h", "box")]),
    { key: "step.label.added", args: { n: 3 } },
    "Add 3 steps",
  ],
  [
    "delete one",
    doc([a, b, d]),
    { key: "step.label.delete", args: { n: 1 }, step: ref("extrude", 1) },
    "Delete Extrude 1",
  ],
  ["delete three", doc([a]), { key: "step.label.delete", args: { n: 3 } }, "Delete 3 steps"],
  ["move one", doc([a, d, b, c]), { key: "step.label.move", step: ref("fillet", 2) }, "Move Fillet 2"],
  ["move two", doc([c, d, a, b]), { key: "step.label.moveMany", args: { n: 4 } }, "Move 4 steps"],
  ["edit of", edited(3.75), { key: "step.label.editOf", step: ref("fillet", 2) }, "edit of Fillet 2"],
  ["rename", doc([a, b, c, rim()]), { key: "step.label.rename", step: ref("fillet", 2) }, "Rename Fillet 2"],
  [
    "edit of a named step",
    doc([a, b, c, rim({ radius: 5.5 })]),
    { key: "step.label.editOf", step: ref("fillet", null, "Rim") },
    "edit of Rim",
  ],
  ["edit of many", editedTwo, { key: "step.label.editMany", args: { n: 2 } }, "Edit 2 steps"],
  ["plain edit", copy(base), { key: "step.label.edit" }, "Edit"],
];

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

describe("stepLabel as data", () => {
  it.each(CASES)("%s is a LateStep and reads as today's English", (_name, after, want, english) => {
    const got = stepLabel(base, after);
    expect(plain(got)).toEqual(plain(want));
    expect(stepText(got, true)).toBe(english);
    expect(stepText(got)).toBe(english);
  });

  it("holds parameter edits by name, and several as one line", () => {
    const p = doc(base.features, { width: 40.5, depth: 12 });
    const one = copy(p);
    one.parameters["width"] = 44.25;
    expect(stepLabel(p, one)).toEqual({ key: "step.label.parameter", args: { name: "width" } });
    const many = copy(one);
    many.parameters["depth"] = 13;
    expect(stepLabel(p, many)).toEqual({ key: "step.label.parameters" });
    expect(stepText(stepLabel(p, one), true)).toBe("Parameter width");
    expect(stepText(stepLabel(p, many), true)).toBe("Parameters");
  });

  it("holds no live feature, only data that survives a copy", () => {
    for (const [, after] of CASES) {
      const got = stepLabel(base, after);
      expect(structuredClone(got)).toEqual(got);
      expect(JSON.stringify(got)).not.toContain("radius");
    }
  });

  it("speaks the same data in German, and keeps a typed name as typed", async () => {
    await setLanguage("de");
    const placed = stepLabel(base, doc([a, b, d]));
    expect(placed).toEqual({ key: "step.label.delete", args: { n: 1 }, step: ref("extrude", 1) });
    expect(stepText(placed)).toContain("Extrusion 1");
    expect(stepText(placed)).not.toContain("Delete");
    expect(stepText(stepLabel(base, doc([a, b, c, rim({ radius: 5.5 })])))).toContain("Rim");
    for (const [name, after] of CASES) {
      const got = stepLabel(base, after);
      expect(englishLeft(stepText(got), stepText(got, true)), name).toEqual([]);
    }
    expect(stepText(stepLabel(base, doc([a])))).toContain("3");
    expect(stepText(stepLabel(base, doc([a])), true)).toBe("Delete 3 steps");
  });
});

describe("a step on the store", () => {
  function twoSteps() {
    const s = freshStore();
    s.addFeature(box("a", 40.5, 22.25, 7));
    s.addFeature({ id: "c", type: "fillet", radius: 1.5 } as unknown as Feature);
    return s;
  }

  it("is named in the language of the moment, also after a switch", async () => {
    await setLanguage("de");
    const s = twoSteps();
    s.updateFeature("c", { radius: 3.25 } as Partial<Feature>);
    const inDe = s.undoLabel!;
    expect(inDe).toContain("Verrundung 1");
    await setLanguage("fr");
    const inFr = s.undoLabel!;
    expect(inFr).not.toBe(inDe);
    expect(inFr).toContain("Congé 1");
    expect(s.undo()).toBe(inFr);
    expect(s.redoLabel).toBe(inFr);
    await setLanguage("system");
    expect(s.redoLabel).toBe("edit of Fillet 1");
    expect(s.redo()).toBe("edit of Fillet 1");
  });

  it("keeps a typed name, a moved step and a suppressed one through a switch", async () => {
    const s = twoSteps();
    s.renameFeature("c", "Rim");
    s.updateFeature("c", { radius: 4.75 } as Partial<Feature>);
    await setLanguage("de");
    expect(s.undoLabel).toContain("Rim");
    s.moveFeature("c", 0);
    await setLanguage("fr");
    expect(s.undoLabel).toContain("Rim");
    s.toggleSuppress("a");
    expect(s.undoLabel).toContain("Boîte 1");
    await setLanguage("de");
    expect(s.undoLabel).toContain("Quader 1");
    s.undo();
    expect(s.undoLabel).toContain("Rim");
  });

  it("names several suppressed steps by count, and one by its name", async () => {
    const s = twoSteps();
    s.setSuppressed(["a", "c"], true);
    expect(s.undoLabel).toBe("Suppress 2 steps");
    s.setSuppressed(["a"], false);
    expect(s.undoLabel).toBe("Unsuppress Box 1");
    await setLanguage("de");
    expect(s.undoLabel).toContain("Quader 1");
    expect(s.undoLabel).not.toContain("Unsuppress");
  });

  it("holds nothing from the first document once a second one loads", async () => {
    await setLanguage("de");
    const s = twoSteps();
    s.updateFeature("c", { radius: 3.25 } as Partial<Feature>);
    expect(s.undoLabel).not.toBeNull();
    s.newDocument();
    expect([s.undoLabel, s.redoLabel]).toEqual([null, null]);
    s.addFeature(box("q", 3.75));
    expect(s.undoLabel).toContain("Quader 1");
    expect(s.undoLabel).not.toContain("Verrundung");
  });
});

describe("the new lines", () => {
  it("every language holds every key of the English table", () => {
    const keys = Object.keys(en).filter((k) => k.startsWith("step.label.") || k.startsWith("history."));
    expect(keys.length).toBeGreaterThan(20);
    for (const lines of [de, fr] as Record<string, string>[]) {
      expect(keys.filter((k) => !(k in lines))).toEqual([]);
    }
  });
});

describe("the spoken history line and the title bar", () => {
  function rig(pending = false) {
    setActivePinia(createPinia());
    announce.mockReset();
    const store = freshStore();
    const e = {
      tools: { move: { pending, cancel: () => {}, settle: () => {}, onHeldChange: () => () => {} } },
      sketch: { active: false, undoEdit: () => false, redoEdit: () => false },
      ui: { panels: { undoStress: () => false, redoStress: () => false } },
      store,
    } as unknown as Engine;
    return { store, e, actions: createDocumentActions(e) };
  }
  const said = () => announce.mock.calls.map((x) => x[0]);

  it("speaks Undid and Redid in the language, and the step in the language", async () => {
    const { store, actions } = rig();
    store.addFeature(box("a", 40.5, 22.25, 7));
    actions.doUndo();
    actions.doRedo();
    actions.doRedo();
    actions.doUndo();
    actions.doUndo();
    expect(said()).toEqual(["Undid Box 1", "Redid Box 1", "Nothing to redo", "Undid Box 1", "Nothing to undo"]);
    await setLanguage("de");
    announce.mockReset();
    actions.doRedo();
    actions.doUndo();
    actions.doUndo();
    expect(said()).toEqual([
      expect.stringContaining("Quader 1"),
      expect.stringContaining("Quader 1"),
      expect.stringContaining("Nichts"),
    ]);
    expect(said()[0]).toMatch(/^Wiederholt/);
    expect(said()[1]).toMatch(/^Rückgängig/);
  });

  it("says Undid Move for a drag not yet entered, in English and in German", async () => {
    expect(rig(true).actions.doUndo()).toBeUndefined();
    expect(said()).toEqual(["Undid Move"]);
    await setLanguage("de");
    const { actions } = rig(true);
    actions.doUndo();
    expect(said()).toEqual([expect.stringContaining("Verschieben")]);
    expect(said()[0]).toMatch(/^Rückgängig/);
  });

  it("syncs the waiting labels on a language switch and holds nothing from the first document", async () => {
    const { store, e } = rig();
    installTitlebar(e);
    const ui = useUiStore();
    store.addFeature(box("a", 40.5, 22.25, 7));
    store.addFeature({ id: "c", type: "fillet", radius: 1.5 } as unknown as Feature);
    store.updateFeature("c", { radius: 3.25 } as Partial<Feature>);
    store.undo();
    await Promise.resolve();
    expect([ui.undoLabel, ui.redoLabel]).toEqual(["Fillet 1", "edit of Fillet 1"]);
    await setLanguage("fr");
    await Promise.resolve();
    expect([ui.undoLabel, ui.redoLabel]).toEqual([store.undoLabel, store.redoLabel]);
    expect(ui.undoLabel).toContain("Congé 1");
    expect(ui.redoLabel).toContain("Congé 1");
    store.newDocument();
    await Promise.resolve();
    expect([ui.undoLabel, ui.redoLabel]).toEqual([null, null]);
    store.addFeature(box("z", 8.5, 3.25, 1.75));
    await setLanguage("de");
    await Promise.resolve();
    expect([ui.undoLabel, ui.redoLabel]).toEqual([expect.stringContaining("Quader 1"), null]);
  });
});
