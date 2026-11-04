// Deleting History or Items steps says what went and offers an Undo that only undoes that delete.

import { beforeEach, describe, expect, it, vi } from "vitest";

const announce = vi.fn();
vi.mock("../../src/ui/announce", () => ({ announce: (...a: unknown[]) => announce(...a) }));

import { createPinia, setActivePinia } from "pinia";
import { deleteRows } from "../../src/app/featureRows";
import { createDocumentActions } from "../../src/app/documentActions";
import { useToastStore } from "../../src/stores/toasts";
import { usePanelsStore } from "../../src/stores/panels";
import { useSelectionStore } from "../../src/stores/selection";
import { opened } from "../document/storeKit";
import type { DocumentStore } from "../../src/document/store";
import type { Engine } from "../../src/app/engine";
import type { Feature } from "../../src/types";

const FEATURES = [
  { id: "a", type: "box", length: 40.5, width: 22.25, height: 7 },
  { id: "b", type: "box", length: 12.5, width: 9, height: 3.25 },
  { id: "m", type: "move", dx: 10, dy: -4.5, dz: 2, rx: 0, ry: 0, rz: 30, bodies: ["body1"] },
] as unknown as Feature[];

function rig(store: DocumentStore = opened({ features: FEATURES })) {
  const selected: (string | null)[] = [];
  const state = { sketchActive: false, pendingMove: false };
  const e = {
    store,
    selectFeature: (id: string | null) => selected.push(id),
    sketch: {
      get active() {
        return state.sketchActive;
      },
      undoEdit: () => false,
      redoEdit: () => false,
    },
    tools: {
      move: {
        get pending() {
          return state.pendingMove;
        },
        cancel: () => {},
      },
      extrude: { profileSketches: [] },
    },
    ui: { panels: { undoStress: () => false, redoStress: () => false } },
  } as unknown as Engine;
  Object.assign(e, createDocumentActions(e));
  return { e, store, selected, state };
}

const ids = (s: DocumentStore) => s.document.features.map((f) => f.id);
const toasts = () => useToastStore().items.map((t) => ({ message: t.message, kind: t.kind, action: t.action?.label }));
const press = (n = 0) => useToastStore().items[n]!.action!.onClick();
const spoken = () => announce.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  setActivePinia(createPinia());
  announce.mockReset();
});

describe("deleteRows", () => {
  it("names one step and offers Undo, which brings it back and says what it undid", () => {
    const { e, store } = rig();
    deleteRows(e, ["b"]);
    expect(ids(store)).toEqual(["a", "m"]);
    expect(toasts()).toEqual([{ message: "Deleted Box 2", kind: "info", action: "Undo" }]);
    expect(spoken()).toEqual(["Deleted Box 2. Undo button in Notifications."]);
    press();
    expect(ids(store)).toEqual(["a", "b", "m"]);
    expect(spoken().at(-1)).toBe("Undid Delete Box 2");
  });

  it("counts several steps", () => {
    const { e, store } = rig();
    deleteRows(e, ["a", "m"]);
    expect(toasts().map((t) => t.message)).toEqual(["Deleted 2 steps"]);
    press();
    expect(ids(store)).toEqual(["a", "b", "m"]);
    expect(spoken().at(-1)).toBe("Undid Delete 2 steps");
  });

  it("drops the selection only when it held a deleted step", () => {
    const { e, selected } = rig();
    useSelectionStore().featureId = "a";
    deleteRows(e, ["b"]);
    expect(selected).toEqual([]);
    deleteRows(e, ["a"]);
    expect(selected).toEqual([null]);
  });

  it("says nothing for ids the document does not have", () => {
    const { e, store } = rig();
    deleteRows(e, ["zz"]);
    deleteRows(e, []);
    expect({ toasts: toasts(), ids: ids(store), canUndo: store.canUndo }).toEqual({
      toasts: [],
      ids: ["a", "b", "m"],
      canUndo: false,
    });
  });
});

describe("the Undo button", () => {
  it("refuses once another step was made, and leaves the document as it was", () => {
    const { e, store } = rig();
    deleteRows(e, ["b"]);
    store.addFeature({ id: "c", type: "box", length: 3.5, width: 4.5, height: 5.5 } as unknown as Feature);
    press();
    expect(ids(store)).toEqual(["a", "m", "c"]);
    expect(toasts().at(-1)!.message).toMatch(/no longer the last step/);
    expect(store.undoLabel).toBe("Box 2");
  });

  it("refuses after Ctrl+Z took the delete back, and works again after a redo", () => {
    const { e, store } = rig();
    deleteRows(e, ["b"]);
    e.doUndo();
    press();
    expect(ids(store)).toEqual(["a", "b", "m"]);
    expect(toasts().at(-1)!.message).toMatch(/no longer the last step/);
    e.doRedo();
    expect(ids(store)).toEqual(["a", "m"]);
    press();
    expect(ids(store)).toEqual(["a", "b", "m"]);
  });

  it("refuses with a sketch open, then works once it is closed", () => {
    const { e, store, state } = rig();
    deleteRows(e, ["b"]);
    state.sketchActive = true;
    press();
    expect(ids(store)).toEqual(["a", "m"]);
    expect(toasts().at(-1)!.message).toMatch(/sketch/i);
    state.sketchActive = false;
    press();
    expect(ids(store)).toEqual(["a", "b", "m"]);
  });

  it("refuses while a Move drag waits to be entered or Stress is open", () => {
    const { e, store, state } = rig();
    deleteRows(e, ["b"]);
    state.pendingMove = true;
    press();
    state.pendingMove = false;
    usePanelsStore().showStress("body1");
    press();
    expect(ids(store)).toEqual(["a", "m"]);
    usePanelsStore().stress = null;
    press();
    expect(ids(store)).toEqual(["a", "b", "m"]);
  });

  it("changes nothing in a second document", () => {
    const first = rig();
    deleteRows(first.e, ["b"]);
    const second = rig(opened({ features: [{ ...FEATURES[0]! }, { ...FEATURES[1]! }] }));
    second.store.removeFeatures(["a"]);
    const markBefore = second.store.undoMark;
    // The first toast's button belongs to the first document's entry, whose mark the second never shares.
    press();
    expect({ ids: ids(second.store), mark: second.store.undoMark }).toEqual({ ids: ["b"], mark: markBefore });
  });
});
