// Double-clicking a feature to edit it while a body is selected: the selection
// raises the Move gizmo by itself, which made the app busy, so the edit was
// silently refused.

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { closeOpenEdit, createSelection } from "../../src/app/selection";
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
      editPreviewId: null,
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
    sketch: { active: false },
    store: {
      document: { features: [{ id: "f1", type: "fillet", radius: 4, edges: [] }] },
      isSuppressed: () => false,
      editPreviewId: null,
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

describe("editFeature on a feature this version does not know", () => {
  it("says it cannot edit it and opens nothing", () => {
    const status: string[] = [];
    const e = {
      viewport: { highlightDatum: () => {} },
      toolBusy: () => false,
      dropBodyGizmo: () => {},
      sketch: { active: false },
      setStatus: (msg: string) => status.push(msg),
      store: {
        document: { features: [{ id: "w1", type: "futureWidget" }] },
        isSuppressed: () => false,
        editPreviewId: null,
        rollbackIndex: 1,
        buildState: { result: { skippedFeatures: [{ feature_id: "w1", type: "futureWidget", message: "" }] } },
      },
    } as unknown as Engine;
    createSelection(e).editFeature("w1");
    expect(status).toEqual(["This version of FundaCAD cannot edit this feature"]);
  });
});

// Another feature's edit is open (its tool, or a sketch being re-edited) and a
// different history row is double clicked: the open edit is closed as a switch
// does and the clicked feature's values open, instead of the first edit staying.
describe("editFeature while another feature's edit is open", () => {
  function engineWithOpenEdit(opts: { sketchEditing?: string }) {
    const state = { entered: 0, extrudeCancelled: 0, finished: 0, extrudeOpen: !opts.sketchEditing };
    const idle = { active: false, cancel: () => {} };
    const tools: Record<string, unknown> = {};
    for (const n of [
      "edgeFeature", "targetEdit", "pressPull", "faceOffset", "draft", "thread", "textOnFace", "hole", "loft",
      "pattern", "planeOffset", "datumPose", "lightAim", "revolvePitch", "joint", "mechanism", "move",
    ]) tools[n] = idle;
    tools.extrude = {
      get active() { return state.extrudeOpen; },
      startEdit: () => true,
      cancel: () => { state.extrudeOpen = false; state.extrudeCancelled++; },
    };
    tools.measure = { active: false, stop: () => {} };
    tools.section = { active: false, picking: false, stop: () => {} };
    const sketch = {
      active: !!opts.sketchEditing,
      editingSketchId: opts.sketchEditing ?? null,
      enter: () => { state.entered++; },
      finish: () => { sketch.active = false; state.finished++; },
    };
    const e = {
      viewport: { highlightDatum: () => {} },
      tools,
      sketch,
      planePick: false,
      toolBusy: () => state.extrudeOpen || sketch.active,
      dropBodyGizmo: () => {},
      store: {
        document: {
          features: [
            { id: "ex1", type: "extrude", sketch: "sk", distance: 2 },
            { id: "sk", type: "sketch", plane: "XY", entities: [] },
          ],
        },
        editPreviewId: opts.sketchEditing ? null : "ex1",
        isSuppressed: () => false,
        rollbackIndex: 2,
        buildState: { result: null },
      },
    };
    return { e: e as unknown as Engine, state };
  }

  it("stands the open tool edit down, then opens the clicked sketch", () => {
    const { e, state } = engineWithOpenEdit({});
    createSelection(e).editFeature("sk");
    expect(state.extrudeCancelled).toBe(1);
    expect(state.entered).toBe(1);
  });

  it("commits an open sketch edit, then edits the clicked feature", () => {
    const { e, state } = engineWithOpenEdit({ sketchEditing: "sk" });
    createSelection(e).editFeature("ex1");
    expect(state.finished).toBe(1);
  });

  it("leaves the edit alone when the clicked feature is the one being edited", () => {
    const { e, state } = engineWithOpenEdit({});
    closeOpenEdit(e, "ex1");
    expect(state.extrudeCancelled).toBe(0);
  });
});
