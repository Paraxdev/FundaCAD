// Double clicking a history row while another feature's edit is open: the open
// edit is closed the way a switch does, then the clicked feature is edited.
// Each open edit below is shaped the way its real tool leaves it: revolve and
// joint begin their preview only on the first change, mechanism and datum keep
// theirs in place, a new sketch has no sketch id yet.

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

const NAMES = [
  "extrude", "edgeFeature", "targetEdit", "pressPull", "faceOffset", "draft", "thread", "textOnFace", "hole", "loft",
  "pattern", "planeOffset", "datumPose", "lightAim", "revolvePitch", "joint", "mechanism", "move",
];

interface Opts {
  /** the tool with an edit open, and the feature it was opened on */
  tool?: { name: string; on: string };
  preview?: { id: string; inPlace?: boolean } | null;
  sketch?: { editing: string | null };
  suppressed?: string[];
}

function mountBar(o: Opts = {}) {
  const log: string[] = [];
  const status: string[] = [];
  type Tool = { active: boolean; cancel: () => void; startEdit: () => boolean };
  const tools: Record<string, Tool | object> = {};
  for (const n of NAMES) {
    const t: Tool = {
      active: o.tool?.name === n,
      cancel: () => { if (t.active) log.push(`cancel:${n}`); t.active = false; },
      startEdit: () => { log.push(`startEdit:${n}`); return true; },
    };
    tools[n] = t;
  }
  tools.measure = { active: false, stop: () => {} };
  tools.section = { active: false, picking: false, stop: () => {} };
  const modalActive = () => NAMES.some((n) => n !== "move" && (tools[n] as Tool).active);
  const sketch = {
    active: !!o.sketch,
    editingSketchId: o.sketch?.editing ?? null,
    enter: () => { log.push("sketch.enter"); },
    finish: (c = true) => { sketch.active = false; log.push(`sketch.finish:${c}`); },
  };
  const e = {
    viewport: { highlightDatum: () => {}, getSelectedFaceIds: () => [], getSelectedBodies: () => [] },
    overlay: { selectedRegions: () => [] },
    bridge: { docVersion: ref(0), buildVersion: ref(0), editPreviewVersion: ref(0), busy: ref({ active: false, waiting: false }) },
    tools,
    sketch,
    planePick: false,
    toolBusy: () => sketch.active || modalActive(),
    toolOwnsScreen: () => sketch.active || modalActive(),
    toolAtWork: () => sketch.active || modalActive(),
    dropBodyGizmo: () => {},
    featureForFace: () => null,
    setStatus: (t: string) => { status.push(t); },
    noteCommitted: () => {},
    store: {
      document: {
        features: [
          { id: "sk", type: "sketch", plane: "XY", entities: [] },
          { id: "ex1", type: "extrude", sketch: "sk", distance: 2 },
          { id: "rv", type: "revolve", sketch: "sk" },
          { id: "jt", type: "joint" },
          { id: "mc", type: "mechanism" },
          { id: "dp", type: "datumPlane", plane: "XY", offset: 5 },
        ],
      },
      get editPreviewId() { return o.preview?.id ?? null; },
      get editPreviewInPlace() { return !!o.preview?.inPlace; },
      onEditPreview: () => () => {},
      isSuppressed: (id: string) => !!o.suppressed?.includes(id),
      rollbackIndex: 6,
      buildState: { result: null, building: false, errorFeatureId: null },
    },
  } as unknown as Engine;
  const sel = createSelection(e);
  Object.assign(e, sel);
  // An edit selects the feature it opens, the tools are mocked so it is done here.
  if (o.tool) useSelectionStore().featureId = o.tool.on;
  useTimelineStore().bind({
    onSelect: (id) => sel.selectFeature(id),
    onEdit: (id) => sel.editFeature(id),
    canRepick: () => false,
    onRepick: () => {},
  });
  const w = mount(TimelineBar, {
    global: { provide: { [ENGINE as symbol]: e }, stubs: { FeatureProperties: true, Icon: true } },
  });
  const chip = (id: string) => w.get(`.timeline-node[data-id="${id}"]`);
  const dbl = (id: string) => chip(id).trigger("dblclick");
  const tool = (n: string) => tools[n] as Tool;
  return { log, status, chip, dbl, tool };
}

describe("History row double click while another edit is open", () => {
  it("stands an open extrude edit down, then edits the clicked row", async () => {
    const m = mountBar({ tool: { name: "extrude", on: "ex1" }, preview: { id: "ex1" } });
    await m.dbl("rv");
    expect(m.log).toEqual(["cancel:extrude", "startEdit:revolvePitch"]);
    expect(useSelectionStore().featureId).toBe("rv");
  });

  it.each([
    ["revolvePitch", "rv"],
    ["joint", "jt"],
  ])("closes an untouched %s edit, which has no preview yet", async (name, on) => {
    const m = mountBar({ tool: { name, on }, preview: null });
    await m.dbl("ex1");
    expect(m.log).toEqual([`cancel:${name}`, "startEdit:extrude"]);
  });

  it.each([
    ["mechanism", "mc"],
    ["datumPose", "dp"],
  ])("closes a dragged %s edit, whose preview is in place", async (name, on) => {
    const m = mountBar({ tool: { name, on }, preview: { id: on, inPlace: true } });
    await m.dbl("ex1");
    expect(m.log).toEqual([`cancel:${name}`, "startEdit:extrude"]);
  });

  it("closes a tool edit whose preview a value typed under its row replaced and ended", async () => {
    // The tool's values show in the properties box under its chip too, typing
    // there takes the one preview slot and the box's blur ends it.
    const m = mountBar({ tool: { name: "extrude", on: "ex1" }, preview: null });
    await m.dbl("rv");
    expect(m.log).toEqual(["cancel:extrude", "startEdit:revolvePitch"]);
  });

  it("edits the clicked row over a properties box preview with no tool open", async () => {
    const m = mountBar({ preview: { id: "rv", inPlace: true } });
    await m.dbl("ex1");
    expect(m.log).toEqual(["startEdit:extrude"]);
  });

  it("commits an open sketch edit, then edits the clicked row", async () => {
    const m = mountBar({ sketch: { editing: "sk" } });
    await m.dbl("ex1");
    expect(m.log).toEqual(["sketch.finish:true", "startEdit:extrude"]);
  });

  it("finishes a new sketch, then edits the clicked row", async () => {
    const m = mountBar({ sketch: { editing: null } });
    await m.dbl("ex1");
    expect(m.log).toEqual(["sketch.finish:true", "startEdit:extrude"]);
  });

  it("leaves the edit alone on a double click of the row being edited", async () => {
    const m = mountBar({ tool: { name: "revolvePitch", on: "rv" }, preview: null });
    await m.dbl("rv");
    expect(m.log).toEqual([]);
  });

  it("keeps the open edit when the clicked row cannot be edited", async () => {
    const m = mountBar({ tool: { name: "extrude", on: "ex1" }, preview: { id: "ex1" }, suppressed: ["rv"] });
    await m.dbl("rv");
    expect(m.log).toEqual([]);
  });

  it("still ignores a single click while an edit is open", async () => {
    const m = mountBar({ tool: { name: "extrude", on: "ex1" }, preview: { id: "ex1" } });
    await m.chip("rv").trigger("click");
    expect(m.log).toEqual([]);
    expect(useSelectionStore().featureId).toBe("ex1");
  });
});
