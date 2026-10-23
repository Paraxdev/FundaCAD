// Mirror writes the bodies it acts on into the feature, never leaving it to
// whichever body happens to be active when the timeline builds.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { createFeatureStarters, type FeatureStartersDeps } from "../../src/features/featureStarters";
import { createActions } from "../../src/app/actions";
import type { Engine } from "../../src/app/engine";

function rig(bodies: { id: string; name: string }[], selected: string[] = [], busy = false) {
  const start = vi.fn();
  const setStatus = vi.fn();
  const selectFeature = vi.fn();
  const noteCommitted = vi.fn();
  const deps = {
    store: { document: { parameters: {}, features: [] }, buildState: { result: { bodies } } },
    viewport: { getSelectedBodies: () => selected },
    overlay: { regions: [], selectedRegions: () => [] },
    canvas: document.createElement("canvas"),
    mirrorTool: { start },
    toolBusy: () => busy,
    hasBody: () => bodies.length > 0,
    setStatus,
    selectFeature,
    noteCommitted,
  } as unknown as FeatureStartersDeps;
  return { starters: createFeatureStarters(deps), start, setStatus, selectFeature, noteCommitted };
}

beforeEach(() => setActivePinia(createPinia()));

describe("Mirror starts its tool with the bodies it should begin with", () => {
  const three = [
    { id: "body1", name: "Rail" },
    { id: "body2", name: "Brace" },
    { id: "body4", name: "Foot" },
  ];

  it("hands over the selected bodies that are built, in selection order", () => {
    const r = rig(three, ["body4", "body9", "body1"]);
    r.starters.startMirror();
    expect(r.start.mock.calls.map((c) => c[0])).toEqual([["body4", "body1"]]);
  });

  it("starts empty when several bodies exist and none is selected", () => {
    const r = rig(three);
    r.starters.startMirror();
    expect(r.start.mock.calls.map((c) => c[0])).toEqual([[]]);
  });

  it("takes the only body without asking", () => {
    const r = rig([{ id: "body7", name: "Rail" }]);
    r.starters.startMirror();
    expect(r.start.mock.calls.map((c) => c[0])).toEqual([["body7"]]);
  });

  it("refuses without a body, and while another tool runs", () => {
    const none = rig([]);
    none.starters.startMirror();
    expect(none.start).not.toHaveBeenCalled();
    expect(none.setStatus).toHaveBeenCalledTimes(1);
    const busy = rig(three, ["body1"], true);
    busy.starters.startMirror();
    expect(busy.start).not.toHaveBeenCalled();
    expect(busy.setStatus).not.toHaveBeenCalled();
  });

  it("selects the new feature once the tool commits", () => {
    const r = rig(three, ["body2"]);
    r.starters.startMirror();
    const onDone = r.start.mock.calls[0]![1] as (id: string | null) => void;
    onDone(null);
    expect(r.selectFeature).not.toHaveBeenCalled();
    onDone("f12");
    expect(r.noteCommitted.mock.calls).toEqual([[null], ["f12"]]);
    expect(r.selectFeature.mock.calls).toEqual([["f12", false]]);
  });
});

describe("body commands with a body selected", () => {
  // Picking a body raises the Move gizmo, which reads as busy, so the ribbon's
  // Mirror and Pattern did nothing at all for a selected body.
  it.each(["mirror", "pattern-linear", "boolean-union"])(
    "%s stands the selection's gizmo down first, to come back on Escape",
    (action) => {
      const order: string[] = [];
      const act = createActions({
        sketch: { active: false },
        starters: {
          startMirror: () => order.push("start"),
          startPattern: () => order.push("start"),
          startBoolean: () => order.push("start"),
        },
        tools: { section: { picking: false, active: false } },
        dropBodyGizmo: () => order.push("drop"),
        restoreBodyGizmo: () => order.push("restore"),
        toolBusy: () => false,
        setStatus: vi.fn(),
        lastAction: null,
      } as unknown as Engine);
      act(action);
      expect(order).toEqual(["drop", "restore", "start"]);
    },
  );
});
