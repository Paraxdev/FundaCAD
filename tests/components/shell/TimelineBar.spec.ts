// Double clicking a history row while another feature's edit is open: the open
// edit is closed the way a switch does, then the clicked feature is edited. The
// chip used to ignore the gesture whenever a tool was busy, so the first
// feature's values stayed open.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TimelineBar from "../../../src/components/shell/TimelineBar.vue";
import { ENGINE } from "../../../src/app/engineKey";
import { createSelection } from "../../../src/app/selection";
import { useTimelineStore } from "../../../src/stores/timeline";
import { useSelectionStore } from "../../../src/stores/selection";
import type { Engine } from "../../../src/app/engine";

vi.mock("../../../src/composables/useSelectionOffers", () => ({
  useSelectionOffers: () => ({ counts: ref({}) }),
}));

beforeEach(() => setActivePinia(createPinia()));

interface Opts {
  sketchEditing?: string;
  suppressed?: string[];
  inPlace?: boolean;
}

function mountBar(opts: Opts = {}) {
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
    viewport: { highlightDatum: () => {}, getSelectedFaceIds: () => [], getSelectedBodies: () => [] },
    overlay: { selectedRegions: () => [] },
    bridge: {
      docVersion: ref(0),
      buildVersion: ref(0),
      editPreviewVersion: ref(0),
      busy: ref({ active: false, waiting: false }),
    },
    tools,
    sketch,
    planePick: false,
    toolBusy: () => state.extrudeOpen || sketch.active,
    dropBodyGizmo: () => {},
    featureForFace: () => null,
    setStatus: () => {},
    store: {
      document: {
        features: [
          { id: "ex1", type: "extrude", sketch: "sk", distance: 2 },
          { id: "sk", type: "sketch", plane: "XY", entities: [] },
        ],
      },
      editPreviewId: opts.sketchEditing ? null : "ex1",
      editPreviewInPlace: !!opts.inPlace,
      onEditPreview: () => () => {},
      isSuppressed: (id: string) => !!opts.suppressed?.includes(id),
      rollbackIndex: 2,
      buildState: { result: null, building: false, errorFeatureId: null },
    },
  } as unknown as Engine;
  const sel = createSelection(e);
  Object.assign(e, sel);
  useTimelineStore().bind({
    onSelect: (id) => sel.selectFeature(id),
    onEdit: (id) => sel.editFeature(id),
    canRepick: () => false,
    onRepick: () => {},
  });
  const w = mount(TimelineBar, {
    global: { provide: { [ENGINE as symbol]: e }, stubs: { FeatureProperties: true, Icon: true } },
  });
  return { w, state, chip: (id: string) => w.get(`.timeline-node[data-id="${id}"]`) };
}

describe("History row double click while another edit is open", () => {
  it("stands the open tool edit down, then edits the clicked row", async () => {
    const { chip, state } = mountBar();
    await chip("sk").trigger("dblclick");
    expect(state.extrudeCancelled).toBe(1);
    expect(state.entered).toBe(1);
    expect(useSelectionStore().featureId).toBe("sk");
  });

  it("commits an open sketch edit, then edits the clicked row", async () => {
    const { chip, state } = mountBar({ sketchEditing: "sk" });
    await chip("ex1").trigger("dblclick");
    expect(state.finished).toBe(1);
  });

  it("leaves the edit alone on a double click of the row being edited", async () => {
    const { chip, state } = mountBar();
    await chip("ex1").trigger("dblclick");
    expect(state.extrudeCancelled).toBe(0);
    expect(state.entered).toBe(0);
  });

  it("keeps the open edit when the clicked row cannot be edited", async () => {
    const { chip, state } = mountBar({ suppressed: ["sk"] });
    await chip("sk").trigger("dblclick");
    expect(state.extrudeCancelled).toBe(0);
  });

  it("leaves a value typed in the properties panel to its own box", async () => {
    const { chip, state } = mountBar({ inPlace: true });
    await chip("sk").trigger("dblclick");
    expect(state.extrudeCancelled).toBe(0);
  });

  it("still ignores a single click while an edit is open", async () => {
    const { chip, state } = mountBar();
    await chip("sk").trigger("click");
    expect(state.extrudeCancelled).toBe(0);
    expect(useSelectionStore().featureId).toBeNull();
  });
});
