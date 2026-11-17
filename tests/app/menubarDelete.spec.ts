// Edit, Delete goes through the same funnel as the Delete key: one message naming the step, with Undo.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSelectionStore } from "../../src/stores/selection";
import { useToastStore } from "../../src/stores/toasts";
import type { Engine } from "../../src/app/engine";
import { buildMenus, row } from "./menuRows";

beforeEach(() => setActivePinia(createPinia()));

describe("Edit, Delete", () => {
  it("removes the picked steps, says which, and Undo asks for that step's mark", () => {
    const removeFeatures = vi.fn();
    const undoIfLatest = vi.fn();
    const selectFeature = vi.fn();
    useSelectionStore().featureId = "f2";
    const e = {
      selectedFeature: "f2",
      deleteSelectedFace: () => false,
      viewport: { getSelectedFaceIds: () => [] },
      selectFeature,
      undoIfLatest,
      store: {
        removeFeatures,
        undoMark: 12,
        document: {
          features: [
            { id: "f1", type: "box" },
            { id: "f2", type: "box" },
          ],
        },
      },
    } as unknown as Engine;
    const del = row("Edit", "Delete", buildMenus(e));
    del.onClick!();
    expect(removeFeatures).toHaveBeenCalledWith(["f2"]);
    expect(selectFeature).toHaveBeenCalledWith(null);
    const shown = useToastStore().items;
    expect(shown.map((t) => t.message)).toEqual(["Deleted Box 2"]);
    shown[0]!.action!.onClick();
    expect(undoIfLatest).toHaveBeenCalledWith(12);
  });
});
