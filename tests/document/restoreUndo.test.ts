// Undo after a restore is the only way back from a version restored by mistake,
// so it brings back everything the restore replaced, not only the features.
import { describe, expect, it, vi } from "vitest";
import type { CadDocument } from "../../src/types";
import type { DocumentStore } from "../../src/document/store";
import { box, env, opened, saved, study } from "./storeKit";

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

  it("takes back a branch switch whole, the branch the next version goes on included", () => {
    const { s, v1 } = workedOn();
    const v2 = s.saveVersion("two")!;
    const before = s.workingSnapshot();
    s.branchFromVersion(v1.id, "lean");
    expect([s.versionRepo!.current, s.workingSnapshot().features]).toEqual(["lean", [box("f1", 10.5)]]);
    s.undo();
    expect(s.workingSnapshot()).toEqual(before);
    expect(s.versionRepo!.current).toBe("main");
    expect(s.changesSinceVersion()).toEqual({ added: [], removed: [], changed: [], settings: false });
    s.redo();
    expect([s.versionRepo!.current, s.workingSnapshot().features]).toEqual(["lean", [box("f1", 10.5)]]);
    s.undo();
    s.addFeature(box("f4", 3.5, 2.25));
    const v3 = s.saveVersion("three")!;
    expect([v3.branch, v3.parent, s.versionRepo!.branches]).toEqual(["main", v2.id, { main: v3.id, lean: v1.id }]);
  });

  it("takes back a switch between two branches that already exist", () => {
    const { s, v1 } = workedOn();
    s.branchFromVersion(v1.id, "lean");
    s.addFeature(box("f5", 6.75, 1.25));
    const lean = s.saveVersion("lean two")!;
    s.switchVersionBranch("main");
    expect([s.versionRepo!.current, s.workingSnapshot().features]).toEqual(["main", [box("f1", 10.5)]]);
    s.undo();
    expect([s.versionRepo!.current, s.workingSnapshot().features]).toEqual(["lean", [box("f1", 10.5), box("f5", 6.75, 1.25)]]);
    expect(s.versionRepo!.branches).toEqual({ main: v1.id, lean: lean.id });
  });

  it("takes back a branch switch made before a replacing load that carried the versions, or leaves them as the load put them", () => {
    const carried = (drop: (d: CadDocument) => void) => {
      const { s, v1 } = workedOn();
      s.branchFromVersion(v1.id, "lean");
      const live = JSON.parse(s.toJSON()) as CadDocument;
      live.features.push(box("f7", 1.75, 4.5));
      drop(live);
      s.loadDocument(live, { replace: true });
      s.undo();
      s.undo();
      return s;
    };
    expect(carried(() => {}).versionRepo!.current).toBe("main");
    const noMain = carried((d) => {
      const repo = d.versions as { branches: Record<string, string> };
      delete repo.branches["main"];
    });
    expect([noMain.versionRepo!.current, Object.keys(noMain.versionRepo!.branches)]).toEqual(["lean", ["lean"]]);
    expect(carried((d) => delete d.versions).versionRepo).toBeNull();
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

  it.each([
    ["stress", { stress: study }, { stress: { future: true, nodes: [1.5, 2] } }, (s: DocumentStore) => s.setStressStudy(null)],
    ["environment", { environment: env(1.75) }, { environment: { name: "future", sky: 3 } }, (s: DocumentStore) => s.setDocumentEnvironment(null)],
  ])("drops the unreadable %s section a replacing load brought once undo brings the readable one back", (key, own, unreadable, clear) => {
    const s = opened({ features: [box("f1", 10.5)], ...own });
    s.loadDocument({ parameters: {}, features: [box("f1", 10.5)], ...unreadable } as CadDocument, { replace: true });
    expect(saved(s)[key]).toEqual(Object.values(unreadable)[0]);
    s.undo();
    expect(saved(s)[key]).toEqual(Object.values(own)[0]);
    clear(s);
    expect(key in saved(s)).toBe(false);
    s.redo();
    expect(saved(s)[key]).toEqual(Object.values(unreadable)[0]);
  });

  it.each([
    ["an isolate", true],
    ["a plain hide", false],
  ])("brings back %s with the bodies it hid, and redo the restored version's view", (_, isolate) => {
    const s = opened({ features: [box("f1", 10.5), box("f2", 4.25, 2)] });
    const v1 = s.saveVersion("one")!;
    (s as unknown as { build: { result: unknown } }).build.result = { bodies: [{ id: "body1" }, { id: "body2" }] };
    if (isolate) s.isolateBodies(["body1"]);
    else s.setBodyVisibility("body2", false);
    s.restoreVersion(v1.id);
    expect([s.isolateActive, s.isBodyVisible("body1"), s.isBodyVisible("body2")]).toEqual([false, true, true]);
    s.undo();
    expect([s.isolateActive, s.isBodyVisible("body1"), s.isBodyVisible("body2")]).toEqual([isolate, true, false]);
    s.redo();
    expect([s.isolateActive, s.isBodyVisible("body1"), s.isBodyVisible("body2")]).toEqual([false, true, true]);
  });

  it("leaves the next document's undo stack alone", () => {
    const { s, v1 } = workedOn();
    s.restoreVersion(v1.id);
    s.load(JSON.stringify({ parameters: {}, features: [box("g1", 3.5)] }));
    expect([s.canUndo, s.canRedo]).toEqual([false, false]);
  });
});
