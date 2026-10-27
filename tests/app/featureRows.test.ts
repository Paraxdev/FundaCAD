// The row selection History and the Items lists share: the keys, the viewport follow, and the end of a document.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createSelection } from "../../src/app/selection";
import { clickFeatureRow, pickedFeatureIds, rowTargets, soleSelectedFeature } from "../../src/app/featureRows";
import { wireDocumentSwap } from "../../src/app/documentSwap";
import { useSelectionStore } from "../../src/stores/selection";
import { freshStore } from "../document/storeKit";
import type { Engine } from "../../src/app/engine";

const ORDER = ["a", "b", "c", "d"];
const plain = { ctrlKey: false, metaKey: false, shiftKey: false };

function fake() {
  const lit: unknown[] = [];
  const e = { viewport: { highlightDatum: (x: unknown) => lit.push(x) } } as unknown as Engine;
  Object.assign(e, createSelection(e));
  return { e, lit };
}

beforeEach(() => setActivePinia(createPinia()));

describe("clickFeatureRow", () => {
  it("follows the body list keys", () => {
    const { e } = fake();
    const sel = useSelectionStore();
    clickFeatureRow(e, ORDER, "b", plain);
    clickFeatureRow(e, ORDER, "d", { ...plain, ctrlKey: true });
    expect(sel.rows.keys).toEqual(["b", "d"]);
    expect(sel.featureId).toBe("d");
    clickFeatureRow(e, ORDER, "d", { ...plain, metaKey: true });
    expect(sel.rows.keys).toEqual(["b"]);
    expect(sel.featureId).toBe("b");
    clickFeatureRow(e, ORDER, "b", plain);
    clickFeatureRow(e, ORDER, "d", { ...plain, shiftKey: true });
    expect(sel.rows.keys).toEqual(["b", "c", "d"]);
    clickFeatureRow(e, ORDER, "a", plain);
    expect(sel.rows.keys).toEqual(["a"]);
  });

  it("lights the datums of the whole selection, one id when only one is picked", () => {
    const { e, lit } = fake();
    clickFeatureRow(e, ORDER, "a", plain);
    clickFeatureRow(e, ORDER, "c", { ...plain, shiftKey: true });
    expect(lit).toEqual(["a", ["a", "b", "c"]]);
  });

  it("an origin plane row is picked without becoming the inspected feature", () => {
    const { e } = fake();
    clickFeatureRow(e, ["o:XY", "o:XZ"], "o:XZ", { ...plain, ctrlKey: true });
    expect(useSelectionStore().rows.keys).toEqual(["o:XZ"]);
    expect(useSelectionStore().featureId).toBeNull();
    expect(rowTargets("o:XZ")).toEqual([]);
  });

  it("a selection the engine made is not a picked row, so Ctrl on another row picks only that one", () => {
    const { e } = fake();
    const store = { document: { features: [{ id: "a" }, { id: "b" }] } };
    e.selectFeature("a", false);
    expect(useSelectionStore().rows.keys).toEqual([]);
    clickFeatureRow(e, ORDER, "b", { ...plain, ctrlKey: true });
    expect(useSelectionStore().rows.keys).toEqual(["b"]);
    expect(pickedFeatureIds({ store, selectedFeature: e.selectedFeature } as unknown as Engine)).toEqual(["b"]);
  });

  it("a selection made elsewhere replaces the picked rows", () => {
    const { e } = fake();
    clickFeatureRow(e, ORDER, "a", plain);
    clickFeatureRow(e, ORDER, "b", { ...plain, ctrlKey: true });
    e.selectFeature("c");
    expect(useSelectionStore().rows).toEqual({ keys: ["c"], anchor: "c" });
  });
});

describe("what acts on the selection", () => {
  it("rowTargets takes the whole selection when the row is in it, else the row", () => {
    const { e } = fake();
    clickFeatureRow(e, ORDER, "a", plain);
    clickFeatureRow(e, ORDER, "b", { ...plain, ctrlKey: true });
    expect(rowTargets("a")).toEqual(["a", "b"]);
    expect(rowTargets("d")).toEqual(["d"]);
  });

  it("pickedFeatureIds is in document order and drops ids the document lacks", () => {
    const { e } = fake();
    const store = { document: { features: [{ id: "a" }, { id: "b" }, { id: "c" }] } };
    clickFeatureRow(e, ORDER, "c", plain);
    clickFeatureRow(e, ORDER, "a", { ...plain, ctrlKey: true });
    clickFeatureRow(e, ORDER, "d", { ...plain, ctrlKey: true });
    expect(pickedFeatureIds({ store, selectedFeature: e.selectedFeature } as unknown as Engine)).toEqual(["a", "c"]);
  });

  it("a tool needing exactly one feature sees none while several are picked", () => {
    const { e } = fake();
    const store = { document: { features: [{ id: "a" }, { id: "b" }, { id: "c" }] } };
    const sole = () => soleSelectedFeature({ store, selectedFeature: e.selectedFeature } as unknown as Engine);
    clickFeatureRow(e, ORDER, "a", plain);
    expect(sole()).toBe("a");
    clickFeatureRow(e, ORDER, "b", { ...plain, ctrlKey: true });
    expect(sole()).toBeNull();
  });

  it("an origin plane picked beside one feature, or a row the document lost, does not make it several", () => {
    const { e } = fake();
    const store = { document: { features: [{ id: "a" }, { id: "b" }] } };
    const sole = () => soleSelectedFeature({ store, selectedFeature: e.selectedFeature } as unknown as Engine);
    clickFeatureRow(e, ["o:XY", "a", "b", "c"], "o:XY", { ...plain, ctrlKey: true });
    clickFeatureRow(e, ["o:XY", "a", "b", "c"], "a", { ...plain, ctrlKey: true });
    expect(useSelectionStore().rows.keys).toEqual(["o:XY", "a"]);
    expect(sole()).toBe("a");
    e.selectFeatureRows({ keys: ["a", "c"], anchor: "a" }, "a");
    expect(sole()).toBe("a");
  });
});

describe("a second document", () => {
  it("keeps none of the first one's picked rows", () => {
    const { e } = fake();
    const store = freshStore();
    const swapTo = { selectFeature: vi.fn((id: null) => e.selectFeature(id)) };
    wireDocumentSwap(store, {
      cancelTools: () => {},
      sketch: { active: false, cancel: () => {} },
      dropBodyGizmo: () => {},
      overlay: { clearRegionSelection: () => {} },
      forgetLastCommit: () => {},
      viewport: { clearSelection: () => {}, setSelectedBodies: () => {}, endDocument: () => {} },
      browser: { forgetDocumentFolders: () => {} },
      ...swapTo,
    });
    clickFeatureRow(e, ORDER, "a", plain);
    clickFeatureRow(e, ORDER, "c", { ...plain, shiftKey: true });
    expect(useSelectionStore().rows.keys).toHaveLength(3);
    store.newDocument();
    expect(useSelectionStore().rows.keys).toEqual([]);
    expect(useSelectionStore().featureId).toBeNull();
    expect(soleSelectedFeature({ store, selectedFeature: e.selectedFeature } as unknown as Engine)).toBeNull();
  });
});
