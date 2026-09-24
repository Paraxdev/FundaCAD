// Double-clicking a feature to edit it while a body is selected: the selection
// raises the Move gizmo by itself, which made the app busy, so the edit was
// silently refused.

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createSelection } from "../../src/app/selection";
import type { Engine } from "../../src/app/engine";

beforeEach(() => setActivePinia(createPinia()));

function fakeEngine(gizmoUp: boolean, otherToolActive = false) {
  const state = { gizmoUp, entered: 0 };
  const e = {
    viewport: { highlightDatum: () => {} },
    toolBusy: () => state.gizmoUp || otherToolActive,
    dropBodyGizmo: () => { state.gizmoUp = false; },
    store: {
      document: { features: [{ id: "sk", type: "sketch", plane: "XY", entities: [] }] },
      isSuppressed: () => false,
      rollbackIndex: 1,
      buildState: { result: null },
    },
    sketch: { enter: () => { state.entered++; } },
  };
  return { e: e as unknown as Engine, state };
}

describe("editFeature", () => {
  it("opens a sketch while a body selection has the Move gizmo up", () => {
    const { e, state } = fakeEngine(true);
    createSelection(e).editFeature("sk");
    expect(state.entered).toBe(1);
    expect(state.gizmoUp).toBe(false);
  });

  it("still refuses while another tool is running", () => {
    const { e, state } = fakeEngine(false, true);
    createSelection(e).editFeature("sk");
    expect(state.entered).toBe(0);
  });
});
