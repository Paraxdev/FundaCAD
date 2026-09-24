// SK-1: exiting a sketch auto-selects its profile feature (selectFeature(id,
// false), see sketchStateBridge.ts) so Extrude has something to work on without
// another click. That auto-selection is not something the user can SEE as
// "selected" the way a click or a tree row is, so Delete must not act on it,
// only on a feature the user explicitly picked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { installKeyboard } from "../../src/app/keyboard";
import type { Engine } from "../../src/app/engine";

function fakeEngine(opts: { selectedFeature: string | null; explicit: boolean }) {
  const removeFeature = vi.fn();
  const selectFeature = vi.fn();
  const e = {
    sketch: { active: false },
    tools: {
      extrude: { active: false },
      edgeFeature: { active: false },
      pressPull: { active: false },
      loft: { active: false },
      planeOffset: { active: false },
      datumPose: { active: false },
    },
    handleAction: () => {},
    viewport: { clearSelection: () => {}, cycleAreaFilter: () => false },
    toolBusy: () => false,
    deleteSelectedFace: () => false,
    selectedFeature: opts.selectedFeature,
    selectedFeatureExplicit: opts.explicit,
    selectFeature,
    store: { removeFeature },
  } as unknown as Engine;
  return { e, removeFeature, selectFeature };
}

function pressDelete() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
}

describe("Delete key", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("does nothing when the selected feature was only an auto-selection", () => {
    const { e, removeFeature, selectFeature } = fakeEngine({ selectedFeature: "f1", explicit: false });
    installKeyboard(e);
    pressDelete();
    expect(removeFeature).not.toHaveBeenCalled();
    expect(selectFeature).not.toHaveBeenCalled();
  });

  it("removes the feature when the user explicitly selected it", () => {
    const { e, removeFeature, selectFeature } = fakeEngine({ selectedFeature: "f1", explicit: true });
    installKeyboard(e);
    pressDelete();
    expect(removeFeature).toHaveBeenCalledWith("f1");
    expect(selectFeature).toHaveBeenCalledWith(null);
  });

  it("does nothing when nothing is selected", () => {
    const { e, removeFeature } = fakeEngine({ selectedFeature: null, explicit: true });
    installKeyboard(e);
    pressDelete();
    expect(removeFeature).not.toHaveBeenCalled();
  });
});
