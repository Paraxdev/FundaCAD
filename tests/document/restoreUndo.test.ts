// Undo after a restore is the only way back from a version restored by mistake,
// so it brings back everything the restore replaced, not only the features.
import { describe, expect, it, vi } from "vitest";
import type { CadDocument } from "../../src/types";
import { box, env, opened, study } from "./storeKit";

vi.stubGlobal("window", globalThis);

function workedOn() {
  const s = opened({ parameters: { w: 7.5 }, features: [box("f1", 10.5)], futureKey: { kept: 1 } });
  const v1 = s.saveVersion("one")!;
  s.addFeature(box("f2", 4.25, 2));
  s.addFeature(box("f3", 2.5, 1.5));
  s.toggleSuppress("f2");
  s.setRollback(2);
  s.setStressStudy(study);
  s.setDocumentEnvironment(env(2.25));
  s.setPaletteSlot(0, { color: "#2a7f3c" });
  s.setBodyName("body1", "Lid");
  s.setBodyColorSlot("body2", 3);
  s.addElement("Hinges");
  s.setReferenceImages([{ id: "r1", src: "plan.png", x: 12.5 }]);
  return { s, v1 };
}

describe("undo after a restore", () => {
  it("brings back the whole working state, and redo the restored one", () => {
    const { s, v1 } = workedOn();
    const before = s.workingSnapshot();
    expect(Object.keys(before).sort()).toEqual([
      "bodyColors", "bodyNames", "elements", "environment", "features", "futureKey", "palette",
      "paramDefs", "parameters", "referenceImages", "rollback", "stress", "suppressed", "version",
    ]);
    s.restoreVersion(v1.id);
    const restored = s.workingSnapshot();
    expect(restored.features).toEqual([box("f1", 10.5)]);
    s.undo();
    expect(s.workingSnapshot()).toEqual(before);
    expect([s.isSuppressed("f2"), s.stressStudy, s.documentEnvironment]).toEqual([true, study, { settings: { exposure: 2.25 } }]);
    s.redo();
    expect(s.workingSnapshot()).toEqual(restored);
    s.undo();
    expect(s.workingSnapshot()).toEqual(before);
  });

  it("keeps the versions and carried sections as they are on both sides", () => {
    const { s, v1 } = workedOn();
    const repo = structuredClone(s.versionRepo);
    const carried = [{ kind: 9, name: "x", hash: "h" }] as never;
    s.carriedSections = carried;
    s.restoreVersion(v1.id);
    s.undo();
    expect(s.versionRepo).toEqual(repo);
    expect(s.carriedSections).toEqual(carried);
    expect(s.changesSinceVersion()).toEqual({ added: ["f2", "f3"], removed: [], changed: [], settings: true });
  });

  it("takes back a branch switch whole", () => {
    const { s, v1 } = workedOn();
    s.saveVersion("two");
    const before = s.workingSnapshot();
    s.branchFromVersion(v1.id, "lean");
    expect(s.workingSnapshot().features).toEqual([box("f1", 10.5)]);
    s.undo();
    expect(s.workingSnapshot()).toEqual(before);
  });

  it("takes back an assistant's or a plugin's replacement of the document whole", () => {
    const { s } = workedOn();
    const before = s.workingSnapshot();
    const next: CadDocument = { parameters: { w: 9 }, features: [box("f1", 10.5), box("f9", 3.75)] };
    s.loadDocument(next, { replace: true });
    expect(s.stressStudy).toBeNull();
    s.undo();
    expect(s.workingSnapshot()).toEqual(before);
  });

  it("leaves the next document's undo stack alone", () => {
    const { s, v1 } = workedOn();
    s.restoreVersion(v1.id);
    s.load(JSON.stringify({ parameters: {}, features: [box("g1", 3.5)] }));
    expect([s.canUndo, s.canRedo]).toEqual([false, false]);
  });
});
