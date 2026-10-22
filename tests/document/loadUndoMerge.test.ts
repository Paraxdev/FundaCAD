// A replacing load is taken back section by section: what the user set off the
// undo stack after it (study, environment, palette, elements, materials) stays.
import { describe, expect, it, vi } from "vitest";
import type { CadDocument, StressStudy } from "../../src/types";
import type { DocumentStore } from "../../src/document/store";
import { box, env, opened, saved, study } from "./storeKit";

vi.stubGlobal("window", globalThis);

const moved: StressStudy = { ...study, body: "body2", loads: [{ ...study.loads[0]!, force: 35, direction: "+X" }] };
const assistantEdit = (): CadDocument => ({ parameters: { w: 9 }, features: [box("f1", 10.5), box("f9", 3.75, 2.5)] });

function workedOn() {
  const s = opened({ parameters: { w: 7.5 }, features: [box("f1", 10.5)], futureKey: { kept: 1 } });
  const v1 = s.saveVersion("one")!;
  s.addFeature(box("f2", 4.25, 2));
  s.setStressStudy(study);
  s.setDocumentEnvironment(env(2.25));
  s.setPaletteSlot(0, { color: "#2a7f3c" });
  s.setBodyColorSlot("body2", 3);
  s.addElement("Hinges");
  s.addMaterial({ name: "Oak", color: "#a0522d" });
  return { s, v1: v1.id };
}

const loads: [string, (s: DocumentStore, v1: string) => void][] = [
  ["a version restore", (s, v1) => s.restoreVersion(v1)],
  ["a branch switch", (s, v1) => void s.branchFromVersion(v1, "lean")],
  ["an assistant's edit", (s) => s.loadDocument(assistantEdit(), { replace: true })],
];

const edits: [string, (s: DocumentStore) => void][] = [
  ["stress", (s) => s.setStressStudy(moved)],
  ["environment", (s) => s.setDocumentEnvironment(env(0.75))],
  ["palette", (s) => s.setPaletteSlot(2, { color: "#7a3cb4", name: "Plum" })],
  ["elements", (s) => void s.addElement("Brackets")],
  ["materials", (s) => void s.addMaterial({ name: "Cork", color: "#c8a165" })],
];

const snap = (s: DocumentStore) => s.workingSnapshot() as unknown as Record<string, unknown>;

describe.each(loads)("undo of %s", (_, load) => {
  it.each(edits)("keeps the %s set after it and brings back every other section", (key, edit) => {
    const { s, v1 } = workedOn();
    const before = snap(s);
    load(s, v1);
    edit(s);
    const edited = snap(s);
    expect(edited[key]).not.toEqual(before[key]);
    s.undo();
    expect(snap(s)).toEqual({ ...before, [key]: edited[key] });
    s.redo();
    expect(snap(s)).toEqual(edited);
  });
});

describe("undo of a replacing load", () => {
  it("keeps a study set after an assistant's edit through undo, redo and a new step", () => {
    const s = opened({ features: [box("f1", 10.5)] });
    s.loadDocument(assistantEdit(), { replace: true });
    s.setStressStudy(study);
    const seen: [string[], StressStudy | null][] = [];
    const look = () => seen.push([s.document.features.map((f) => f.id), s.stressStudy]);
    s.undo();
    look();
    s.redo();
    look();
    s.undo();
    s.addFeature(box("f4", 3.5, 2.25));
    s.undo();
    look();
    s.redo();
    look();
    expect(seen).toEqual([
      [["f1"], study],
      [["f1", "f9"], study],
      [["f1"], study],
      [["f1", "f4"], study],
    ]);
  });

  it("brings back a section set after it to the value the load left, then the one before", () => {
    const { s } = workedOn();
    const before = snap(s);
    s.loadDocument(assistantEdit(), { replace: true });
    s.setStressStudy(moved);
    s.setStressStudy(null);
    s.undo();
    expect(snap(s)).toEqual(before);
  });

  it("lets redo keep a section set after the undo and redo the rest", () => {
    const { s } = workedOn();
    s.loadDocument(assistantEdit(), { replace: true });
    const loaded = snap(s);
    s.undo();
    expect(s.stressStudy).toEqual(study);
    s.setStressStudy(moved);
    s.redo();
    expect(snap(s)).toEqual({ ...loaded, stress: moved });
  });

  it("takes back the newer version's sections a load brought, changed or dropped, and redo brings them again", () => {
    const s = opened({ features: [box("f1", 10.5)], futureKey: { kept: 1 }, olderKey: [2.5, -1] });
    const before = saved(s);
    const next = JSON.parse(s.toJSON()) as CadDocument & Record<string, unknown>;
    delete next["olderKey"];
    Object.assign(next, { futureKey: { kept: 2 }, newerKey: { added: "yes" } });
    next.features.push(box("f9", 3.75, 2.5));
    s.loadDocument(next, { replace: true });
    const loaded = saved(s);
    s.undo();
    expect(saved(s)).toEqual(before);
    s.redo();
    expect(saved(s)).toEqual(loaded);
    expect([loaded["futureKey"], loaded["newerKey"], "olderKey" in loaded]).toEqual([{ kept: 2 }, { added: "yes" }, false]);
  });

  it("keeps only the sections the load changed in its step, never the geometry", () => {
    const big = "0123456789abcdef".repeat(4096);
    const s = opened({ parameters: { w: 7.5 }, features: [box("f1", 10.5)], futureKey: { blob: big }, stress: study });
    const next = JSON.parse(s.toJSON()) as CadDocument & Record<string, unknown>;
    Object.assign(next, {
      parameters: { w: 9 },
      paramDefs: { w: { expr: "9", value: 9, unit: "mm" } },
      paramExtras: { w: { comment: "width" } },
      features: [box("f1", 10.5), box("f9", 3.75, 2.5)],
      viewOverrides: { top: { normal: [0.2, -0.3, 0.93], up: [0, 1, 0] } },
      bodyIds: { "f9:0": "body2" },
      stress: moved,
      environment: env(1.5),
    });
    s.loadDocument(next, { replace: true });
    const top = (s as unknown as { undoStack: { state?: Map<string, { put?: string }> }[] }).undoStack.at(-1)!;
    const kept = [...top.state!].map(([k, v]) => [k, v.put === undefined ? undefined : JSON.parse(v.put)]);
    expect(kept.sort()).toEqual([["environment", undefined], ["stress", study]]);
  });

  it("keeps no section when the load changed only the geometry", () => {
    const s = opened({ features: [box("f1", 10.5)], stress: study, futureKey: { kept: 1 } });
    const next = JSON.parse(s.toJSON()) as CadDocument;
    next.features.push(box("f9", 3.75, 2.5));
    s.loadDocument(next, { replace: true });
    const top = (s as unknown as { undoStack: { state?: Map<string, unknown> }[] }).undoStack.at(-1)!;
    expect(top.state).toEqual(new Map());
  });
});

type Built = { build: { result: unknown } };
const bodies = (s: DocumentStore) => {
  (s as unknown as Built).build.result = { bodies: [{ id: "body1" }, { id: "body2" }, { id: "body3" }] };
};
// The suppress set is a set, so its order is left out of the comparison.
const state = (s: DocumentStore) => {
  const o = snap(s);
  if (Array.isArray(o["suppressed"])) o["suppressed"] = [...(o["suppressed"] as string[])].sort();
  return { ...o, isolate: s.isolateActive };
};

const steps: [string, object, CadDocument, (s: DocumentStore) => void][] = [
  [
    "a suppressed step removed",
    { features: [box("f1", 10.5), box("f2", 4.25, 2)], suppressed: ["f2"] },
    { parameters: {}, features: [box("f1", 10.5), box("f9", 3.75, 2.5)], suppressed: ["f9"] },
    (s) => s.removeFeature("f9"),
  ],
  [
    "a step removed above the rollback marker",
    { features: [box("f1", 10.5), box("f2", 4.25, 2), box("f3", 6.5)], rollback: 2 },
    { parameters: {}, features: [box("f1", 10.5), box("f9", 3.75, 2.5), box("f4", 5.5)], rollback: 2 },
    (s) => s.removeFeature("f1"),
  ],
  [
    "a step added at the rollback marker",
    { features: [box("f1", 10.5), box("f2", 4.25, 2), box("f3", 6.5)], rollback: 2 },
    { parameters: {}, features: [box("f1", 10.5), box("f9", 3.75, 2.5), box("f4", 5.5)], rollback: 1 },
    (s) => s.addFeature(box("f5", 2.75, 1.5)),
  ],
  [
    "two steps added at the rollback marker",
    { features: [box("f1", 10.5), box("f2", 4.25, 2), box("f3", 6.5)], rollback: 2 },
    { parameters: {}, features: [box("f1", 10.5), box("f9", 3.75, 2.5), box("f4", 5.5)], rollback: 1 },
    (s) => s.addFeatures([box("f5", 2.75, 1.5), box("f6", 1.25)]),
  ],
  [
    "an edit with a step added at the rollback marker",
    { features: [box("f1", 10.5), box("f2", 4.25, 2), box("f3", 6.5)], rollback: 2 },
    { parameters: {}, features: [box("f1", 10.5), box("f9", 3.75, 2.5), box("f4", 5.5)], rollback: 1 },
    (s) => s.editAndAdd((d) => void ((d.features[0] as unknown as { length: number }).length = 8.25), [box("f5", 2.75)]),
  ],
];

describe("undo of a step taken after a replacing load", () => {
  it.each(steps)("puts back what the load left after %s, then what came before it", (_, first, next, step) => {
    const s = opened(first);
    bodies(s);
    const before = state(s);
    s.loadDocument(next, { replace: true });
    bodies(s);
    const loaded = state(s);
    step(s);
    const stepped = state(s);
    expect(stepped).not.toEqual(loaded);
    expect(loaded).not.toEqual(before);
    const seen = [];
    s.undo();
    seen.push(state(s));
    s.undo();
    seen.push(state(s));
    s.redo();
    seen.push(state(s));
    s.redo();
    seen.push(state(s));
    expect(seen).toEqual([loaded, before, loaded, stepped]);
  });

  it.each([
    ["one step", 2, (s: DocumentStore) => s.addFeature(box("f5", 2.75, 1.5))],
    ["two steps", 3, (s: DocumentStore) => s.addFeatures([box("f5", 2.75, 1.5), box("f6", 1.25)])],
    ["an edit and a step", 2, (s: DocumentStore) => s.editAndAdd((d) => d.features.reverse(), [box("f5", 2.75)])],
  ] as const)("moves the rollback marker past %s added at it, and back on undo", (_, marker, add) => {
    const s = opened({ features: [box("f1", 10.5), box("f2", 4.25, 2), box("f3", 6.5)], rollback: 1 });
    const seen = [];
    for (const step of [add, (t: DocumentStore) => t.undo(), (t: DocumentStore) => t.redo()]) {
      step(s);
      seen.push(s.rollbackIndex);
    }
    expect(seen).toEqual([marker, 1, marker]);
  });

  it("brings back the suppress set the load replaced after a removal of its suppressed step", () => {
    const s = opened({ features: [box("f1", 10.5), box("f2", 4.25, 2)], suppressed: ["f2"] });
    s.loadDocument({ parameters: {}, features: [box("f1", 10.5), box("f9", 3.75, 2.5)], suppressed: ["f9"] }, { replace: true });
    s.removeFeature("f9");
    s.undo();
    s.undo();
    expect([s.document.features.map((f) => f.id), s.isSuppressed("f2"), s.isSuppressed("f9"), s.rollbackIndex]).toEqual([
      ["f1", "f2"], true, false, 2,
    ]);
  });
});
