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

// Every way to reach a fillet/chamfer's edit routes through the SAME call
// (edgeFeature.startEdit), whether the radius is a plain literal or a bare
// reference to a parameter (see params/engine.bareParamRef, edgeFeatureTool
// c4e7f8cf). This is the routing every entry path shares: double-click in
// history, the context menu's Edit, and the viewport's double-click-a-face
// (app/viewportWiring.ts) all end up here, so a regression here breaks all of
// them at once, whatever renders and clicks the entry point.
function fakeFilletEngine(startEditResult: boolean) {
  const state = { startEditCalls: [] as string[], statusCalls: [] as string[] };
  const e = {
    viewport: { highlightDatum: () => {} },
    toolBusy: () => false,
    dropBodyGizmo: () => {},
    store: {
      document: { features: [{ id: "f1", type: "fillet", radius: 4, edges: [] }] },
      isSuppressed: () => false,
      rollbackIndex: 1,
      buildState: { result: null },
    },
    setStatus: (msg: string) => { state.statusCalls.push(msg); },
    tools: {
      edgeFeature: {
        startEdit: (id: string) => {
          state.startEditCalls.push(id);
          return startEditResult;
        },
      },
    },
  };
  return { e: e as unknown as Engine, state };
}

describe("editFeature: fillet/chamfer", () => {
  it("routes to edgeFeature.startEdit regardless of a plain or parameter-bound radius", () => {
    const { e, state } = fakeFilletEngine(true);
    createSelection(e).editFeature("f1");
    expect(state.startEditCalls).toEqual(["f1"]);
    expect(state.statusCalls).toEqual([]); // the tool opened, no fallback message
  });

  it("falls back to the values-in-history status when startEdit refuses", () => {
    const { e, state } = fakeFilletEngine(false);
    createSelection(e).editFeature("f1");
    expect(state.startEditCalls).toEqual(["f1"]);
    expect(state.statusCalls.length).toBe(1);
  });
});
