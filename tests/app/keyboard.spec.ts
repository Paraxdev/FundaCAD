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

// PH-2: Ctrl+A outside a field selected the text of the whole app.
describe("Ctrl+A", () => {
  const selectAll = (target: EventTarget, init: KeyboardEventInit = { ctrlKey: true }) => {
    const ev = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
  };

  beforeEach(() => {
    document.body.innerHTML = "";
    installKeyboard(fakeEngine({ selectedFeature: null, explicit: false }).e);
  });

  it("does not select the page from the canvas or a button", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    expect(selectAll(document.body)).toBe(true);
    expect(selectAll(button)).toBe(true);
    expect(selectAll(document.body, { metaKey: true })).toBe(true);
  });

  it("stays the field's own select all inside an input or an editable label", () => {
    const input = document.createElement("input");
    const label = document.createElement("div");
    label.contentEditable = "true";
    document.body.append(input, label);
    expect(selectAll(input)).toBe(false);
    expect(selectAll(label)).toBe(false);
  });
});
