// The section cut is saved with the document as a view: off the model, off the undo stack, and replaced by the
// next document's own cut or none.

import { describe, expect, it, vi } from "vitest";
import { DocumentStore, KNOWN_DOC_KEYS, carriedKeys } from "../../src/document/store";
import { isEmptyDiff, type VersionRepo } from "../../src/document/versions";
import type { GeometryBackend } from "../../src/geometry/client";
import type { CadDocument, Feature, SectionView } from "../../src/types";

vi.stubGlobal("window", globalThis);

function stub() {
  const rebuild = vi.fn(async () => ({ ok: false, error: { message: "stub" } }));
  const backend = {
    rebuild,
    async init() {},
    onStatus() {
      return () => {};
    },
    connected: true,
  } as unknown as GeometryBackend;
  return { backend, rebuild };
}

const CUT: SectionView = { origin: [62.5, 18.25, 20], normal: [0.6, 0, 0.8], offset: -9.5, side: -1, ghost: "faint" };
const CUT_C: SectionView = { origin: [-14, 33, 7.5], normal: [0, -0.8, 0.6], offset: 4.75, side: 1, ghost: "strong" };
const box = (id: string, x: number): Feature => ({ id, type: "box", length: 20 + x, width: 12, height: 7 } as Feature);
const doc = (features: Feature[], extra: Partial<CadDocument> = {}) => JSON.stringify({ parameters: {}, features, ...extra });

const fresh = () => new DocumentStore(stub().backend, { parameters: {}, features: [box("a1", 3)] });
const saved = (store: DocumentStore) => JSON.parse(store.toJSON()) as Record<string, unknown>;
const undoDepth = (store: DocumentStore) => (store as unknown as { undoStack: unknown[] }).undoStack.length;

describe("the section cut in the document", () => {
  it("save and reopen give the same cut", () => {
    const store = fresh();
    store.setSectionView(structuredClone(CUT));
    const again = fresh();
    again.load(store.toJSON());
    expect(again.sectionView).toEqual(CUT);
    expect(saved(again).sectionView).toEqual(CUT);
  });

  it("writes no key while no cut is on", () => {
    const store = fresh();
    expect("sectionView" in saved(store)).toBe(false);
    store.setSectionView(structuredClone(CUT));
    store.setSectionView(null);
    expect("sectionView" in saved(store)).toBe(false);
  });

  it("is not part of what the engine builds, rebuilds nothing and leaves the undo stack alone", () => {
    const { backend, rebuild } = stub();
    const store = new DocumentStore(backend, { parameters: {}, features: [box("a1", 3)] });
    rebuild.mockClear();
    const depth = undoDepth(store);
    store.setSectionView(structuredClone(CUT));
    expect("sectionView" in store.document).toBe(false);
    expect("sectionView" in store.builtDocument()).toBe(false);
    expect(rebuild).not.toHaveBeenCalled();
    expect(undoDepth(store)).toBe(depth);
  });

  it("stays where it is through an undo and a redo of a model edit made after it", () => {
    const store = fresh();
    store.setSectionView(structuredClone(CUT));
    store.addFeature(box("a2", 9));
    store.undo();
    expect(store.sectionView).toEqual(CUT);
    store.redo();
    expect(store.document.features.map((f) => f.id)).toEqual(["a1", "a2"]);
    expect(store.sectionView).toEqual(CUT);
  });

  it("marks the document unsaved when it changes, and not for the same cut again", () => {
    const store = fresh();
    store.markSaved("C:/parts/bracket.funda");
    store.setSectionView(structuredClone(CUT));
    expect(store.dirty).toBe(true);
    store.markSaved("C:/parts/bracket.funda");
    store.setSectionView(structuredClone(CUT));
    expect(store.dirty).toBe(false);
    store.setSectionView({ ...CUT, offset: -8 });
    expect(store.dirty).toBe(true);
  });

  it("hands back a cut with a long normal read as unit length, to its listener too, and the next document has its own", () => {
    const store = fresh();
    const seen: (SectionView | null)[] = [];
    store.onSectionViewChange((v) => seen.push(v && structuredClone(v)));
    store.setSectionView({ ...CUT, normal: [1.5, 0, 2] });
    expect([store.sectionView, saved(store).sectionView]).toEqual([CUT, CUT]);
    store.load(doc([box("b1", 1)], { sectionView: { ...CUT_C, normal: [0, -2, 1.5] } }));
    expect(store.sectionView).toEqual(CUT_C);
    store.load(doc([box("b2", 2)]));
    expect([store.sectionView, seen]).toEqual([null, [null, CUT, CUT_C, null]]);
  });

  it("refuses a cut it cannot read and keeps the one it has", () => {
    const store = fresh();
    store.setSectionView(structuredClone(CUT));
    store.setSectionView({ ...CUT, normal: [0, 0, 0] });
    expect(store.sectionView).toEqual(CUT);
  });

  it("tells listeners on subscribe, on a change, on open and on New, and stops when unsubscribed", () => {
    const store = fresh();
    const seen: (SectionView | null)[] = [];
    const off = store.onSectionViewChange((v) => seen.push(v && structuredClone(v)));
    store.setSectionView(structuredClone(CUT));
    store.setSectionView(structuredClone(CUT));
    store.load(doc([box("b1", 1)], { sectionView: CUT_C }));
    store.newDocument();
    off();
    store.setSectionView(structuredClone(CUT));
    expect(seen).toEqual([null, CUT, CUT_C, null]);
  });

  it("does not carry a cut into the next document", () => {
    const store = fresh();
    store.load(doc([box("a1", 3)], { sectionView: CUT }));
    expect(store.sectionView).toEqual(CUT);
    store.load(doc([box("b1", 1)]));
    expect(store.sectionView).toBeNull();
    expect("sectionView" in saved(store)).toBe(false);
    store.load(doc([box("c1", 5)], { sectionView: CUT_C }));
    expect(store.sectionView).toEqual(CUT_C);
    store.newDocument();
    expect(store.sectionView).toBeNull();
  });

  it("keeps the cut for a replacing load of the same document unless that brings its own", () => {
    const store = fresh();
    store.setSectionView(structuredClone(CUT));
    store.load(doc([box("a1", 3), box("a2", 4)]), { replace: true });
    expect(store.sectionView).toEqual(CUT);
    store.load(doc([box("a1", 3)], { sectionView: CUT_C }), { replace: true });
    expect(store.sectionView).toEqual(CUT_C);
    store.load(doc([box("z9", 2)]), { replace: true });
    expect(store.sectionView).toBeNull();
  });

  it("stays where it is through an undo and a redo of a replacing load, also one that brought a cut", () => {
    const store = fresh();
    const palette = [{ name: "Teal", color: "#2a9d8f" }];
    const before = saved(store).palette;
    store.setSectionView(structuredClone(CUT));
    store.load(doc([box("a1", 3), box("a2", 4)], { sectionView: CUT_C, palette }), { replace: true });
    expect(store.sectionView).toEqual(CUT_C);
    store.undo();
    expect(store.document.features.map((f) => f.id)).toEqual(["a1"]);
    expect(saved(store).palette).toEqual(before);
    expect(store.sectionView).toEqual(CUT_C);
    store.setSectionView(null);
    store.redo();
    expect(store.document.features.map((f) => f.id)).toEqual(["a1", "a2"]);
    expect(saved(store).palette).toEqual(palette);
    expect(store.sectionView).toBeNull();
    expect("sectionView" in saved(store)).toBe(false);
  });

  it("leaves versions out of it: a cut is no change, and restoring a version keeps it", () => {
    const store = fresh();
    store.saveVersion("first");
    store.setSectionView(structuredClone(CUT));
    expect("sectionView" in store.workingSnapshot()).toBe(false);
    expect(isEmptyDiff(store.changesSinceVersion()!)).toBe(true);
    expect(store.saveVersion("again")).toBeNull();
    store.addFeature(box("a2", 9));
    const first = store.versionRepo!.versions[0]!.id;
    store.restoreVersion(first);
    expect(store.document.features.map((f) => f.id)).toEqual(["a1"]);
    expect(store.sectionView).toEqual(CUT);
  });

  // An older app keeps the cut as a key it does not know, and its versions record such keys.
  it("restores a version an older app saved with a cut in it without that cut, and sees no change after", () => {
    const old = fresh();
    old.saveVersion("old");
    const repo = old.versionRepo as VersionRepo;
    const v = repo.versions[0]!;
    const rest = { ...(JSON.parse(repo.objects[v.tree.rest]!) as object), sectionView: CUT_C };
    repo.objects["old-rest"] = JSON.stringify(rest);
    v.tree.rest = "old-rest";
    old.addFeature(box("a2", 9));
    const store = fresh();
    store.load(old.toJSON());
    store.setSectionView(structuredClone(CUT));
    store.restoreVersion(store.versionRepo!.versions[0]!.id);
    expect([store.document.features.map((f) => f.id), store.sectionView, saved(store).sectionView]).toEqual([["a1"], CUT, CUT]);
    expect(store.changesSinceVersion()).toEqual({ added: [], removed: [], changed: [], settings: false });
    store.load(doc([box("b1", 1)]));
    expect([store.sectionView, store.versionRepo]).toEqual([null, null]);
  });

  it("still sees a setting changed since an older app's version with a cut in it", () => {
    const old = fresh();
    old.saveVersion("old");
    const repo = old.versionRepo as VersionRepo;
    const v = repo.versions[0]!;
    repo.objects["old-rest"] = JSON.stringify({ ...(JSON.parse(repo.objects[v.tree.rest]!) as object), sectionView: CUT_C });
    v.tree.rest = "old-rest";
    const store = fresh();
    store.load(old.toJSON());
    store.setParam("depth", 12.5);
    expect(store.changesSinceVersion()).toEqual({ added: [], removed: [], changed: [], settings: true });
  });

  it("writes back a cut it cannot read while it has none of its own, and lets a cut set here replace it", () => {
    const store = fresh();
    const newer = [CUT, CUT_C];
    store.load(doc([box("a1", 3)], { sectionView: newer as unknown as SectionView }));
    expect(store.sectionView).toBeNull();
    expect(saved(store).sectionView).toEqual(newer);
    store.load(doc([box("a1", 3), box("a2", 4)]), { replace: true });
    expect(saved(store).sectionView).toEqual(newer);
    store.setSectionView(structuredClone(CUT_C));
    expect(saved(store).sectionView).toEqual(CUT_C);
    store.setSectionView(null);
    expect("sectionView" in saved(store)).toBe(false);
  });

  it("keeps fields a newer version wrote through save, reopen and a move, and drops them with Off", () => {
    const store = fresh();
    store.load(doc([box("a1", 3)], { sectionView: { ...CUT, name: "Front" } as SectionView }));
    const again = fresh();
    again.load(store.toJSON());
    expect(again.sectionView).toEqual({ ...CUT, name: "Front" });
    again.setSectionView({ ...CUT, offset: 2.5 });
    expect(saved(again).sectionView).toEqual({ ...CUT, offset: 2.5, name: "Front" });
    again.setSectionView(null);
    again.setSectionView(structuredClone(CUT));
    expect(saved(again).sectionView).toEqual(CUT);
  });

  it("an older reader carries it as a key it does not know", () => {
    const store = fresh();
    store.setSectionView(structuredClone(CUT));
    const older = new Set([...KNOWN_DOC_KEYS].filter((k) => k !== "sectionView"));
    expect(carriedKeys(saved(store), older).sectionView).toEqual(CUT);
  });
});
