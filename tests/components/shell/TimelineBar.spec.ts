// Double clicking a history row while another feature's edit is open: the open
// edit is closed the way a switch does, then the clicked feature is edited.
// Each open edit below is shaped the way its real tool leaves it: revolve and
// joint begin their preview only on the first change, mechanism and datum keep
// theirs in place, a new sketch has no sketch id yet.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TimelineBar from "../../../src/components/shell/TimelineBar.vue";
import { ENGINE } from "../../../src/app/engineKey";
import { createSelection } from "../../../src/app/selection";
import { DimInput } from "../../../src/sketch/dimInput";
import { useTimelineStore } from "../../../src/stores/timeline";
import { useSelectionStore } from "../../../src/stores/selection";
import type { Engine } from "../../../src/app/engine";
import { contextMenu, type CtxItem } from "../../../src/ui/menu";
import { announce } from "../../../src/ui/announce";

vi.mock("../../../src/ui/menu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/ui/menu")>()),
  contextMenu: vi.fn(),
}));
vi.mock("../../../src/ui/announce", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/ui/announce")>()),
  announce: vi.fn(),
}));
vi.mock("../../../src/composables/useSelectionOffers", () => ({
  useSelectionOffers: () => ({ counts: ref({}) }),
}));

beforeEach(() => setActivePinia(createPinia()));

const boxes: DimInput[] = [];
afterEach(() => {
  for (const b of boxes.splice(0)) b.dispose();
});

const NAMES = [
  "extrude",
  "edgeFeature",
  "targetEdit",
  "pressPull",
  "faceOffset",
  "draft",
  "thread",
  "textOnFace",
  "hole",
  "loft",
  "pattern",
  "mirror",
  "planeOffset",
  "datumPose",
  "lightAim",
  "revolvePitch",
  "joint",
  "mechanism",
  "move",
];

interface Opts {
  /** the tool with an edit open, and the feature it was opened on */
  tool?: { name: string; on: string };
  preview?: { id: string; inPlace?: boolean } | null;
  sketch?: { editing: string | null };
  suppressed?: string[];
  features?: object[];
  /** what the engine is busy with: an import, or a rebuild */
  busy?: "import" | "rebuild";
  /** every running op, oldest first, when more than the one `busy` names */
  ops?: ("import" | "rebuild")[];
  /** sketches with a picked region, which seed Related to Selection */
  regions?: string[];
  /** features the last build failed */
  failed?: string[];
  /** features that built with something to say: id -> reason */
  notes?: Record<string, string>;
  /** the saved rollback marker, 6 (after every feature) when left out */
  rollback?: number;
  /** mounted into the document, so focus moves */
  attach?: boolean;
}

function mountBar(o: Opts = {}) {
  const log: string[] = [];
  const status: string[] = [];
  type Tool = { active: boolean; cancel: () => void; startEdit: () => boolean };
  const tools: Record<string, Tool | object> = {};
  for (const n of NAMES) {
    const t: Tool = {
      active: o.tool?.name === n,
      cancel: () => {
        if (t.active) log.push(`cancel:${n}`);
        t.active = false;
      },
      startEdit: () => {
        log.push(`startEdit:${n}`);
        return true;
      },
    };
    tools[n] = t;
  }
  tools.measure = { active: false, stop: () => {} };
  tools.section = { active: false, picking: false, stop: () => {} };
  const modalActive = () => NAMES.some((n) => n !== "move" && (tools[n] as Tool).active);
  const sketch = {
    active: !!o.sketch,
    editingSketchId: o.sketch?.editing ?? null,
    enter: () => {
      log.push("sketch.enter");
    },
    finish: (c = true) => {
      sketch.active = false;
      log.push(`sketch.finish:${c}`);
    },
  };
  const e = {
    viewport: { highlightDatum: () => {}, getSelectedFaceIds: () => [], getSelectedBodies: () => [] },
    overlay: { selectedRegions: () => (o.regions ?? []).map((sketchId) => ({ sketchId })) },
    bridge: {
      docVersion: ref(0),
      buildVersion: ref(0),
      editPreviewVersion: ref(0),
      busy: ref({ active: !!o.busy, waiting: null, rebuild: o.busy === "rebuild" }),
      ops: ref(
        (o.ops ?? (o.busy ? [o.busy] : [])).map((kind, i) => ({
          key: i + 1,
          label: kind === "import" ? "Importing sv08.step" : "Rebuilding",
          stage: null,
          pct: null,
          rebuild: kind === "rebuild",
        })),
      ),
    },
    tools,
    sketch,
    planePick: false,
    toolBusy: () => sketch.active || modalActive(),
    toolOwnsScreen: () => sketch.active || modalActive(),
    toolAtWork: () => sketch.active || modalActive(),
    dropBodyGizmo: () => {},
    featureForFace: () => null,
    setStatus: (t: string) => {
      status.push(t);
    },
    noteCommitted: () => {},
    store: {
      document: {
        features: o.features ?? [
          { id: "sk", type: "sketch", plane: "XY", entities: [] },
          { id: "ex1", type: "extrude", sketch: "sk", distance: 2 },
          { id: "rv", type: "revolve", sketch: "sk" },
          { id: "jt", type: "joint" },
          { id: "mc", type: "mechanism" },
          { id: "dp", type: "datumPlane", plane: "XY", offset: 5 },
        ],
      },
      get editPreviewId() {
        return o.preview?.id ?? null;
      },
      get editPreviewInPlace() {
        return !!o.preview?.inPlace;
      },
      onEditPreview: () => () => {},
      isSuppressed: (id: string) => !!o.suppressed?.includes(id),
      setSuppressed: (ids: string[], on: boolean) => log.push(`suppress:${on}:${ids.join(",")}`),
      removeFeatures: (ids: string[]) => log.push(`remove:${ids.join(",")}`),
      rollbackIndex: o.rollback ?? 6,
      buildState: {
        result:
          o.failed || o.notes
            ? {
                featureErrors: (o.failed ?? []).map((id) => ({ feature_id: id, message: "failed" })),
                diagnostics: Object.entries(o.notes ?? {}).map(([feature_id, reason]) => ({ feature_id, reason })),
              }
            : null,
        building: false,
        errorFeatureId: null,
      },
      cancelRunningOp: (key: number) => {
        log.push(`cancelOp:${key}`);
        return Promise.resolve(true);
      },
      renameFeature: (id: string, name: string) => log.push(`rename:${id}:${name}`),
      setRollback: (i: number) => log.push(`rollback:${i}`),
      moveFeature: (id: string, to: number) => {
        log.push(`move:${id}:${to}`);
        const list = (e.store.document as unknown as { features: { id: string }[] }).features;
        const [f] = list.splice(
          list.findIndex((x) => x.id === id),
          1,
        );
        list.splice(to, 0, f!);
        e.bridge.docVersion.value++;
      },
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
    ...(o.attach ? { attachTo: document.body } : {}),
    global: { provide: { [ENGINE as symbol]: e }, stubs: { FeatureProperties: true, Icon: true } },
  });
  const chip = (id: string) => w.get(`.timeline-node[data-id="${id}"]`);
  const dbl = (id: string) => chip(id).trigger("dblclick");
  const tool = (n: string) => tools[n] as Tool;
  return { log, status, chip, dbl, tool, w, e };
}

/** A heads-up box with `text` typed into its one field, as a tool shows it. */
function typedBox(text: string, onCommit: () => void) {
  const box = new DimInput();
  boxes.push(box);
  box.show([{ name: "distance", label: "Distance", kind: "length" }], onCommit, () => {});
  const input = document.querySelector<HTMLInputElement>(".dim-input input")!;
  input.value = text;
  input.dispatchEvent(new Event("input"));
  return box;
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

  it("enters a value typed in the heads-up box instead of throwing it away", async () => {
    const m = mountBar({ tool: { name: "extrude", on: "ex1" }, preview: { id: "ex1" } });
    typedBox("5", () => {
      m.log.push("commit:extrude");
      m.tool("extrude").active = false;
    });
    await m.dbl("rv");
    expect(m.log).toEqual(["commit:extrude", "startEdit:revolvePitch"]);
  });

  it("keeps the edit and says why when the typed value is refused", async () => {
    const m = mountBar({ tool: { name: "extrude", on: "ex1" }, preview: { id: "ex1" } });
    typedBox("abc", () => {
      m.log.push("commit:extrude");
      m.tool("extrude").active = false;
    });
    await m.dbl("rv");
    expect(m.log).toEqual([]);
    expect(m.tool("extrude").active).toBe(true);
    expect(m.status.at(-1)).toMatch(/value being typed/);
    expect(useSelectionStore().featureId).toBe("ex1");
  });

  it("keeps the edit and says so when entering the value leaves the tool open", async () => {
    const m = mountBar({ tool: { name: "extrude", on: "ex1" }, preview: { id: "ex1" } });
    typedBox("5", () => {
      m.log.push("commit:extrude");
    });
    await m.dbl("rv");
    expect(m.log).toEqual(["commit:extrude"]);
    expect(m.status.at(-1)).toMatch(/Finish this edit/);
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

describe("an import's chip", () => {
  const nodes = [
    { name: "Gearbox", parent: null },
    { name: "Shaft", parent: 0 },
  ];
  const imp = (id: string, name: string, extra: object = {}) => ({
    id,
    type: "import",
    format: "step",
    name,
    source: "/in/gear-box.step",
    ...extra,
  });

  it("is named by the assembly Items shows and keeps the file name in its tooltip", () => {
    const m = mountBar({ features: [imp("i1", "gear-box", { nodes })] });
    expect(m.chip("i1").find(".t-name").text()).toBe("Gearbox");
    expect(m.chip("i1").attributes("title")).toContain("File: gear-box");
  });

  it("is named by its own name when it was renamed or has no assembly, with no file line", () => {
    const m = mountBar({ features: [imp("i1", "Housing", { nodes }), imp("i2", "gear-box")] });
    expect(m.chip("i1").find(".t-name").text()).toBe("Housing");
    expect(m.chip("i2").find(".t-name").text()).toBe("gear-box");
    expect(m.chip("i2").attributes("title")).not.toContain("File:");
  });

  it("reads the file name in the chip's description too, since a screen reader skips the tooltip", () => {
    const m = mountBar({ features: [imp("i1", "gear-box", { nodes }), imp("i2", "gear-box")] });
    expect(said(m, "i1")).toBe("Import, step 1 of 2, file: gear-box");
    expect(said(m, "i2")).toBe("Import, step 2 of 2");
  });
});

/** The text of the description a chip points at. */
function said(m: ReturnType<typeof mountBar>, id: string) {
  const ref = m.chip(id).attributes("aria-describedby");
  return ref === undefined ? undefined : m.w.get(`[id="${ref}"]`).text();
}

describe("a chip's state in words", () => {
  it("is named by its step and reads its position, a failure, a suppression and a roll back as its description", () => {
    const m = mountBar({ failed: ["ex1"], suppressed: ["rv"], rollback: 4 });
    expect(m.chip("ex1").attributes("aria-label")).toBe(m.chip("ex1").get(".t-name").text());
    expect(said(m, "sk")).toBe("step 1 of 6");
    expect(said(m, "ex1")).toBe("step 2 of 6, failed: failed");
    expect(said(m, "rv")).toBe("step 3 of 6, suppressed");
    expect(said(m, "jt")).toBe("step 4 of 6");
    expect(said(m, "mc")).toBe("step 5 of 6, rolled back");
    expect(said(m, "dp")).toBe("step 6 of 6, rolled back");
  });

  it("reads a note as a warning and a picked step as selected", async () => {
    const m = mountBar({ notes: { jt: "no faces moved" } });
    expect(said(m, "jt")).toBe("step 4 of 6, warning: no faces moved");
    await m.chip("rv").trigger("click");
    expect(said(m, "rv")).toBe("step 3 of 6, selected");
    expect(said(m, "jt")).toBe("step 4 of 6, warning: no faces moved");
  });

  it("reads the kind of a step that carries a name of its own", () => {
    const ext = (id: string, name?: string) => ({ id, type: "extrude", sketch: "s", distance: 1, name });
    const m = mountBar({ features: [ext("a", "Lid"), ext("b"), ext("c", "Extrude top")] });
    expect(m.chip("a").attributes("aria-label")).toBe("Lid");
    expect(said(m, "a")).toBe("Extrude, step 1 of 3");
    expect(said(m, "b")).toBe("step 2 of 3");
    expect(said(m, "c")).toBe("step 3 of 3");
  });

  it("reads a step whose Active when condition is 0 as switched off", () => {
    const m = mountBar({ features: [{ id: "a", type: "sketch", plane: "XY", entities: [], activeWhen: 0 }] });
    expect(said(m, "a")).toBe("step 1 of 1, switched off");
  });

  it("marks the step the model is built up to as the current step, and none when all is rolled back", () => {
    const current = (m: ReturnType<typeof mountBar>) =>
      ["sk", "ex1", "rv", "jt", "mc", "dp"].map((id) => m.chip(id).attributes("aria-current") ?? "");
    expect(current(mountBar({ rollback: 3 }))).toEqual(["", "", "step", "", "", ""]);
    expect(current(mountBar())).toEqual(["", "", "", "", "", "step"]);
    expect(current(mountBar({ rollback: 0 }))).toEqual(["", "", "", "", "", ""]);
    expect(current(mountBar({ rollback: 6, preview: { id: "ex1" } }))).toEqual(["", "step", "", "", "", ""]);
  });
});

describe("History's empty line", () => {
  const sketch = { id: "sk1", type: "sketch", plane: "XZ", entities: [] };

  it("names a sketch and a dropped file as the ways to start", () => {
    const m = mountBar({ features: [] });
    const line = m.w.find(".timeline-empty").text();
    expect(line).toContain("Start with a Sketch");
    expect(line).toContain("drop a STEP, STL or 3MF file");
  });

  it("is gone once there is a feature, one or many", () => {
    expect(
      mountBar({ features: [sketch] })
        .w.find(".timeline-empty")
        .exists(),
    ).toBe(false);
    expect(mountBar().w.find(".timeline-empty").exists()).toBe(false);
  });

  it("stays away while the first import runs, and shows during an empty rebuild", () => {
    expect(mountBar({ features: [], busy: "import" }).w.find(".timeline-empty").exists()).toBe(false);
    expect(mountBar({ features: [], busy: "rebuild" }).w.find(".timeline-empty").exists()).toBe(true);
  });
});

// The SV08 read for minutes with no History step, and an emptied History said "remeshing…" for another document's op.
describe("History's rows for running ops", () => {
  it("lists an import from the moment it starts, under any rebuild, and its Cancel stops only it", async () => {
    const m = mountBar({ features: [], busy: "rebuild", ops: ["import", "rebuild"] });
    const rows = m.w.findAll(".timeline-node.running");
    expect({
      rows: rows.map((r) => r.find(".t-build").text()),
      empty: m.w.find(".timeline-empty").exists(),
      chip: m.w.find(".timeline-node.building").exists(),
    }).toEqual({ rows: ["Importing sv08.step"], empty: false, chip: false });
    await rows[0]!.find(".t-op-cancel").trigger("click");
    expect(m.log).toEqual(["cancelOp:1"]);
  });

  it("shows no row and the empty line while only the document's own rebuild runs", () => {
    const m = mountBar({ features: [], busy: "rebuild" });
    expect({
      rows: m.w.findAll(".timeline-node.running").length,
      empty: m.w.find(".timeline-empty").exists(),
    }).toEqual({ rows: 0, empty: true });
  });
});

describe("History rows picked together", () => {
  const ids = ["sk", "ex1", "rv", "jt", "mc", "dp"];
  const lit = (m: ReturnType<typeof mountBar>) => ids.map((id) => m.chip(id).classes("selected"));
  const menu = async (m: ReturnType<typeof mountBar>, id: string) => {
    await m.chip(id).trigger("contextmenu");
    return vi.mocked(contextMenu).mock.calls.at(-1)![2] as CtxItem[];
  };

  it("a plain click picks one, Ctrl toggles, Shift takes a run", async () => {
    const m = mountBar();
    await m.chip("ex1").trigger("click");
    await m.chip("jt").trigger("click", { ctrlKey: true });
    expect(lit(m)).toEqual([false, true, false, true, false, false]);
    await m.chip("ex1").trigger("click", { metaKey: true });
    expect(lit(m)).toEqual([false, false, false, true, false, false]);
    await m.chip("rv").trigger("click");
    await m.chip("dp").trigger("click", { shiftKey: true });
    expect(lit(m)).toEqual([false, false, true, true, true, true]);
    await m.chip("sk").trigger("click");
    expect(lit(m)).toEqual([true, false, false, false, false, false]);
  });

  it("shows the values under one picked chip only", async () => {
    const m = mountBar();
    await m.chip("ex1").trigger("click");
    expect(m.w.findAll(".timeline-props")).toHaveLength(1);
    await m.chip("rv").trigger("click", { shiftKey: true });
    expect(m.w.findAll(".timeline-props")).toHaveLength(0);
  });

  it("folds the open chip on a second plain click, but not on the second click of a double-click", async () => {
    const m = mountBar();
    await m.chip("ex1").trigger("click", { detail: 1 });
    expect(m.w.findAll(".timeline-props")).toHaveLength(1);
    await m.chip("ex1").trigger("click", { detail: 1 });
    expect(m.w.findAll(".timeline-props")).toHaveLength(0);
    expect(lit(m)).toEqual([false, false, false, false, false, false]);
    await m.chip("ex1").trigger("click", { detail: 1 });
    await m.chip("ex1").trigger("click", { detail: 2 });
    expect(m.w.findAll(".timeline-props")).toHaveLength(1);
  });

  it("still shows the values of the one feature picked beside an origin plane or a row the document lost", async () => {
    const m = mountBar();
    m.e.selectFeatureRows({ keys: ["o:XY", "ex1"], anchor: "ex1" }, "ex1");
    await m.w.vm.$nextTick();
    expect(m.w.findAll(".timeline-props")).toHaveLength(1);
    m.e.selectFeatureRows({ keys: ["ex1", "gone"], anchor: "ex1" }, "ex1");
    await m.w.vm.$nextTick();
    expect(m.w.findAll(".timeline-props")).toHaveLength(1);
  });

  it("F2 renames the one picked chip and does nothing while several are picked", async () => {
    const m = mountBar({
      features: [
        { id: "a", type: "joint" },
        { id: "b", type: "joint" },
      ],
    });
    const f2 = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "F2" }));
    await m.chip("a").trigger("click");
    f2();
    await m.w.vm.$nextTick();
    expect(m.w.find(".t-rename").exists()).toBe(true);
    m.w.unmount();
    const n = mountBar({
      features: [
        { id: "a", type: "joint" },
        { id: "b", type: "joint" },
      ],
    });
    await n.chip("b").trigger("click");
    await n.chip("a").trigger("click", { ctrlKey: true });
    f2();
    await n.w.vm.$nextTick();
    expect(n.w.find(".t-rename").exists()).toBe(false);
    n.w.unmount();
  });

  it("suppresses and deletes the whole selection, and greys the single-feature items with a reason", async () => {
    const m = mountBar();
    await m.chip("ex1").trigger("click");
    await m.chip("jt").trigger("click", { shiftKey: true });
    const items = await menu(m, "rv");
    expect(items.filter((i) => i.disabled).map((i) => i.label)).toEqual([
      "Edit (select one feature)",
      "Rename (select one feature)",
      "Roll back before this (select one feature)",
    ]);
    items.find((i) => i.label === "Suppress these 3")!.onClick!();
    items.find((i) => i.label === "Delete these 3")!.onClick!();
    expect(m.log).toEqual(["suppress:true:ex1,rv,jt", "remove:ex1,rv,jt"]);
    expect(useSelectionStore().rows.keys).toEqual([]);
  });

  it("a right-click on a row beside one the document lost menus that feature alone", async () => {
    const m = mountBar();
    m.e.selectFeatureRows({ keys: ["ex1", "gone"], anchor: "ex1" }, "ex1");
    const items = await menu(m, "ex1");
    expect(items.some((i) => i.label === "Edit" && !i.disabled)).toBe(true);
    expect(items.some((i) => i.label.startsWith("Suppress these"))).toBe(false);
  });

  it("a right-click outside the selection menus that feature alone", async () => {
    const m = mountBar();
    await m.chip("ex1").trigger("click");
    await m.chip("jt").trigger("click", { ctrlKey: true });
    const items = await menu(m, "mc");
    expect(items.some((i) => i.label === "Edit" && !i.disabled)).toBe(true);
  });

  it("lights every picked step's datum in the view", async () => {
    const m = mountBar();
    const lit2: unknown[] = [];
    (m.e as unknown as { viewport: { highlightDatum: (x: unknown) => void } }).viewport.highlightDatum = (x) =>
      lit2.push(x);
    await m.chip("dp").trigger("click");
    await m.chip("ex1").trigger("click", { ctrlKey: true });
    expect(lit2).toEqual(["dp", ["dp", "ex1"]]);
  });
});

describe("History's rename field and controls", () => {
  const jt = [{ id: "jt", type: "joint" }];
  async function renaming() {
    const m = mountBar({ features: jt });
    await m.chip("jt").trigger("click");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F2" }));
    await m.w.vm.$nextTick();
    const input = m.w.get<HTMLInputElement>(".t-rename input");
    return { m, input };
  }

  it("opens a base text field on the chip, holding the shown name", async () => {
    const { m, input } = await renaming();
    expect(m.w.get(".t-rename").classes()).toContain("ui-text-field");
    expect(input.element.closest(".timeline-node")?.getAttribute("data-id")).toBe("jt");
    expect(input.element.value).not.toBe("");
  });

  it("names the field Rename for a screen reader", async () => {
    const { input } = await renaming();
    expect(input.attributes("aria-label")).toBe("Rename");
  });

  it("saves on Enter once and closes", async () => {
    const { m, input } = await renaming();
    await input.setValue("Hinge");
    await input.trigger("keydown", { key: "Enter" });
    await input.trigger("blur");
    await m.w.vm.$nextTick();
    expect(m.log.filter((l) => l.startsWith("rename:"))).toEqual(["rename:jt:Hinge"]);
    expect(m.w.find(".t-rename").exists()).toBe(false);
  });

  it("cancels on Escape without saving", async () => {
    const { m, input } = await renaming();
    await input.setValue("Hinge");
    await input.trigger("keydown", { key: "Escape" });
    await input.trigger("blur");
    await m.w.vm.$nextTick();
    expect(m.log.filter((l) => l.startsWith("rename:"))).toEqual([]);
    expect(m.w.find(".t-rename").exists()).toBe(false);
  });

  it("saves on blur and closes", async () => {
    const { m, input } = await renaming();
    await input.setValue("Hinge");
    await input.trigger("blur");
    await m.w.vm.$nextTick();
    expect(m.log.filter((l) => l.startsWith("rename:"))).toEqual(["rename:jt:Hinge"]);
    expect(m.w.find(".t-rename").exists()).toBe(false);
  });

  it("keeps a click and a double click in the field out of the chip", async () => {
    const { m, input } = await renaming();
    const before = [...m.log];
    await input.trigger("click");
    await input.trigger("dblclick");
    await m.w.get(".t-rename").trigger("dblclick");
    expect(m.log).toEqual(before);
    expect(m.w.find(".t-rename").exists()).toBe(true);
  });

  it("the transport is base icon buttons that keep their titles and stand down at the ends", async () => {
    const m = mountBar({ features: jt });
    const btns = m.w.findAll(".timeline-transport .tl-btn");
    expect(btns.map((b) => [b.classes("icon-btn"), b.attributes("title")])).toEqual([
      [true, "Roll back to the start"],
      [true, "Step one feature back"],
      [true, "Step one feature forward"],
      [true, "Roll forward to the end"],
    ]);
    await btns[0]!.trigger("click");
    expect(m.log).toContain("rollback:0");
    expect(btns[2]!.attributes("aria-disabled")).toBe("true");
    await btns[2]!.trigger("click");
    expect(m.log.filter((l) => l.startsWith("rollback:"))).toEqual(["rollback:0"]);
  });

  it("the head's close, error badge and Cancel are base controls", () => {
    const m = mountBar({ features: jt, busy: "import" });
    expect(m.w.get("#timeline .float-card-close").classes()).toContain("icon-btn");
    expect(m.w.get("#timeline .float-card-close").attributes("title")).toContain("Hide the history");
    const badge = m.w.get(".timeline-errbadge");
    expect([badge.element.tagName, badge.classes("chip"), badge.attributes("title")]).toEqual([
      "BUTTON",
      true,
      "Failing features, click to jump to the next one",
    ]);
    expect(m.w.get(".timeline-cancel").classes()).toContain("btn");
    expect(m.w.get(".t-op-cancel").classes()).toContain("btn");
    expect(m.w.get(".t-op-cancel").attributes("title")).toBe("Stop Importing sv08.step");
  });
});

describe("History's head toggles", () => {
  const RELATED_KEY = "fundacad.historyRelated";
  beforeEach(() => localStorage.removeItem(RELATED_KEY));

  const relatedState = (m: ReturnType<typeof mountBar>) => {
    const t = m.w.get('[data-testid="history-related"]');
    return {
      on: t.classes("on"),
      pressed: t.attributes("aria-pressed"),
      label: t.attributes("aria-label"),
      text: t.text(),
      saved: localStorage.getItem(RELATED_KEY),
    };
  };

  it("Related to Selection shows only while something is picked", () => {
    expect(mountBar().w.find('[data-testid="history-related"]').exists()).toBe(false);
  });

  it("Related to Selection turns off and on again from a click, and remembers it", async () => {
    const m = mountBar({ regions: ["sk"] });
    expect(relatedState(m)).toEqual({
      on: true,
      pressed: "true",
      label: "Related to Selection, 3",
      text: "Related to Selection · 3",
      saved: null,
    });
    await m.w.get('[data-testid="history-related"]').trigger("click");
    expect(relatedState(m)).toEqual({
      on: false,
      pressed: "false",
      label: "Related to Selection, 3",
      text: "Related to Selection · 3",
      saved: "0",
    });
    await m.w.get('[data-testid="history-related"]').trigger("click");
    expect([relatedState(m).on, relatedState(m).pressed, relatedState(m).saved]).toEqual([true, "true", "1"]);
  });

  it("the error badge hides with no failures", () => {
    expect(mountBar().w.get(".timeline-errbadge").classes("hidden")).toBe(true);
  });

  it("the error badge names a single failure in the singular", () => {
    const badge = mountBar({ failed: ["ex1"] }).w.get(".timeline-errbadge");
    expect([badge.text(), badge.attributes("aria-label")]).toEqual([
      "1",
      "1 failing feature, click to jump to the next one",
    ]);
  });

  it("the error badge counts the failures and each click jumps to the next one", async () => {
    const scrolled: (string | null)[] = [];
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this.getAttribute("data-id"));
    });
    try {
      const m = mountBar({ failed: ["ex1", "rv"] });
      const badge = m.w.get(".timeline-errbadge");
      expect([badge.classes("hidden"), badge.text(), badge.attributes("aria-label")]).toEqual([
        false,
        "2",
        "2 failing features, click to jump to the next one",
      ]);
      const picked: (string | null)[] = [];
      for (let i = 0; i < 3; i++) {
        await badge.trigger("click");
        picked.push(useSelectionStore().featureId);
      }
      expect({ picked, scrolled }).toEqual({ picked: ["ex1", "rv", "ex1"], scrolled: ["ex1", "rv", "ex1"] });
    } finally {
      scroll.mockRestore();
    }
  });
});

describe("History steps by keys", () => {
  const ids = ["sk", "ex1", "rv", "jt", "mc", "dp"];
  const mounted: ReturnType<typeof mountBar>[] = [];
  afterEach(() => {
    for (const m of mounted.splice(0)) m.w.unmount();
  });
  // Vue skips a handler for an event first seen in the ms it was attached.
  const open = async (o: Opts = {}) => {
    const m = mountBar({ ...o, attach: true });
    mounted.push(m);
    await new Promise((r) => setTimeout(r, 2));
    return m;
  };
  const el = (m: ReturnType<typeof mountBar>, id: string) => m.chip(id).element as HTMLElement;
  const focused = () => (document.activeElement as HTMLElement | null)?.dataset.id;
  const press = (key: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    (document.activeElement ?? document.body).dispatchEvent(e);
    return e;
  };
  const lit = (m: ReturnType<typeof mountBar>) => ids.map((id) => m.chip(id).classes("selected"));

  it("is a list named Steps of buttons with one Tab stop, on the last step built", async () => {
    const m = await open({ rollback: 3, ops: ["import"] });
    const track = m.w.get(".timeline-track");
    expect(track.attributes("role")).toBe("list");
    expect(track.attributes("aria-label")).toBe("Steps");
    expect(m.w.findAll(".timeline-item").map((x) => x.attributes("role"))).toEqual(ids.map(() => "listitem"));
    expect(m.w.get(".timeline-node.running").attributes("role")).toBe("listitem");
    expect(ids.map((id) => m.chip(id).attributes("role"))).toEqual(ids.map(() => "button"));
    expect(ids.map((id) => m.chip(id).attributes("tabindex"))).toEqual(["-1", "-1", "0", "-1", "-1", "-1"]);
    await m.chip("jt").trigger("click");
    expect(m.chip("jt").attributes("tabindex")).toBe("0");
  });

  it("names no list while the empty line shows", async () => {
    const m = await open({ features: [] });
    expect(m.w.get(".timeline-track").attributes("role")).toBeUndefined();
  });

  it("walks the steps with the arrows, Home and End, stops at the ends and keeps the keys from the window", async () => {
    const m = await open();
    const heard = vi.fn();
    window.addEventListener("keydown", heard);
    el(m, "ex1").focus();
    press("ArrowDown");
    expect(focused()).toBe("rv");
    press("ArrowRight");
    expect(focused()).toBe("jt");
    press("ArrowUp");
    press("ArrowLeft");
    expect(focused()).toBe("ex1");
    press("Home");
    expect(focused()).toBe("sk");
    press("ArrowUp");
    expect(focused()).toBe("sk");
    press("End");
    expect(focused()).toBe("dp");
    press("ArrowDown");
    expect(focused()).toBe("dp");
    expect(heard).not.toHaveBeenCalled();
    window.removeEventListener("keydown", heard);
    await m.w.vm.$nextTick();
    expect(m.chip("dp").attributes("tabindex")).toBe("0");
  });

  it("Space picks a step and folds it again, Shift+Space takes a run", async () => {
    const m = await open();
    el(m, "rv").focus();
    press(" ");
    await m.w.vm.$nextTick();
    expect(lit(m)).toEqual([false, false, true, false, false, false]);
    expect(m.w.findAll(".timeline-props")).toHaveLength(1);
    press(" ");
    await m.w.vm.$nextTick();
    expect(m.w.findAll(".timeline-props")).toHaveLength(0);
    press(" ");
    el(m, "mc").focus();
    press(" ", { shiftKey: true });
    await m.w.vm.$nextTick();
    expect(lit(m)).toEqual([false, false, true, true, true, false]);
  });

  it("Enter edits the focused step, closing an open edit first", async () => {
    const m = await open({ tool: { name: "extrude", on: "ex1" }, preview: { id: "ex1" } });
    el(m, "rv").focus();
    const e = press("Enter");
    expect(e.defaultPrevented).toBe(true);
    expect(m.log).toEqual(["cancel:extrude", "startEdit:revolvePitch"]);
  });

  it("F2 renames the focused step, picked or not, and Enter in the field hands focus back", async () => {
    const m = await open();
    await m.chip("sk").trigger("click");
    el(m, "jt").focus();
    press("F2");
    await m.w.vm.$nextTick();
    await m.w.vm.$nextTick();
    const field = m.chip("jt").find(".t-rename input");
    expect(field.exists()).toBe(true);
    expect(m.chip("jt").attributes("role")).toBeUndefined();
    expect(document.activeElement).toBe(field.element);
    press("ArrowDown");
    expect(m.chip("jt").find(".t-rename input").exists()).toBe(true);
    (field.element as HTMLInputElement).value = "Hinge";
    await field.trigger("input");
    await new Promise((r) => setTimeout(r, 2));
    press("Enter");
    await m.w.vm.$nextTick();
    await m.w.vm.$nextTick();
    expect(m.log).toContain("rename:jt:Hinge");
    expect(focused()).toBe("jt");
    expect(m.chip("jt").attributes("role")).toBe("button");
  });

  it.each([
    ["Shift+F10", { key: "F10", shiftKey: true }],
    ["the Menu key", { key: "ContextMenu" }],
  ])(
    "%s opens the step's menu under it, and the browser's own contextmenu after it opens no second",
    async (_, init) => {
      const m = await open();
      vi.mocked(contextMenu).mockClear();
      el(m, "ex1").focus();
      const e = press(init.key, init);
      expect(e.defaultPrevented).toBe(true);
      expect(vi.mocked(contextMenu)).toHaveBeenCalledTimes(1);
      const [x, y, items] = vi.mocked(contextMenu).mock.calls[0]!;
      const r = el(m, "ex1").getBoundingClientRect();
      expect([x, y]).toEqual([r.left + 24, r.bottom]);
      expect((items as CtxItem[]).map((i) => i.label)).toContain("Rename");
      await m.chip("ex1").trigger("contextmenu");
      expect(vi.mocked(contextMenu)).toHaveBeenCalledTimes(1);
      await m.chip("ex1").trigger("contextmenu");
      expect(vi.mocked(contextMenu)).toHaveBeenCalledTimes(2);
    },
  );

  it("Alt with an arrow moves the focused step past its neighbour, says where it went and keeps focus on it", async () => {
    const m = await open();
    vi.mocked(announce).mockClear();
    const heard = vi.fn();
    window.addEventListener("keydown", heard);
    el(m, "rv").focus();
    const e = press("ArrowLeft", { altKey: true });
    await m.w.vm.$nextTick();
    expect(e.defaultPrevented).toBe(true);
    expect(focused()).toBe("rv");
    press("ArrowDown", { altKey: true });
    await m.w.vm.$nextTick();
    press("ArrowRight", { altKey: true });
    await m.w.vm.$nextTick();
    press("ArrowUp", { altKey: true });
    await m.w.vm.$nextTick();
    window.removeEventListener("keydown", heard);
    expect(heard).not.toHaveBeenCalled();
    expect(m.log.filter((l) => l.startsWith("move:"))).toEqual(["move:rv:1", "move:rv:2", "move:rv:3", "move:rv:2"]);
    expect(vi.mocked(announce).mock.calls.map((c) => c[0])).toEqual([
      "Moved Revolve before Extrude",
      "Moved Revolve after Extrude",
      "Moved Revolve after Joint",
      "Moved Revolve before Joint",
    ]);
    expect(m.w.findAll(".timeline-node[data-id]").map((x) => x.attributes("data-id"))).toEqual(ids);
    expect(focused()).toBe("rv");
    expect(m.chip("rv").attributes("tabindex")).toBe("0");
  });

  it("says a step at either end is already first or last and moves nothing", async () => {
    const m = await open();
    vi.mocked(announce).mockClear();
    el(m, "sk").focus();
    press("ArrowLeft", { altKey: true });
    el(m, "dp").focus();
    press("ArrowRight", { altKey: true });
    expect(m.log.filter((l) => l.startsWith("move:"))).toEqual([]);
    expect(vi.mocked(announce).mock.calls.map((c) => c[0])).toEqual([
      "Sketch is already the first step",
      "Datum Plane is already the last step",
    ]);
  });

  it("moves a step past the next one Related to Selection shows, not one it hides", async () => {
    localStorage.removeItem("fundacad.historyRelated");
    const feats = [
      { id: "sk", type: "sketch", plane: "XY", entities: [] },
      { id: "jt", type: "joint" },
      { id: "ex1", type: "extrude", sketch: "sk", distance: 2 },
    ];
    const m = await open({ features: feats, regions: ["sk"] });
    expect(m.w.get('.timeline-item[data-feature="jt"]').isVisible()).toBe(false);
    vi.mocked(announce).mockClear();
    el(m, "ex1").focus();
    press("ArrowLeft", { altKey: true });
    expect(m.log.filter((l) => l.startsWith("move:"))).toEqual(["move:ex1:0"]);
    expect(vi.mocked(announce)).toHaveBeenCalledWith("Moved Extrude before Sketch");
  });

  it("lets a press outside the History take focus off a clicked step", async () => {
    const m = await open();
    el(m, "rv").focus();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(focused()).toBeUndefined();
    el(m, "rv").focus();
    el(m, "jt").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(focused()).toBe("rv");
  });
});
