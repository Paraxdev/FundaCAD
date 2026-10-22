import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as read from "../../src/harness/readouts";
import { clearLog, logError } from "../../src/ui/logStore";
import { toast } from "../../src/ui/toast";
import { useToastStore } from "../../src/stores/toasts";
import { mountApp } from "./fixture";

function host(over: Partial<{ roll: number; suppressed: string[]; hidden: string[]; busy: object; building: boolean; features: object[] }> = {}): read.ReadHost {
  const features = over.features ?? [
    { id: "s1", type: "sketch" },
    { id: "e1", type: "extrude", name: "Plate" },
    { id: "d1", type: "draft" },
    { id: "f1", type: "fillet" },
  ];
  return {
    store: {
      document: { parameters: {}, features },
      buildState: {
        building: over.building ?? false, progress: null, meshed: null, meshTotal: null, streamed: null, streamTotal: null,
        errorFeatureId: "d1", errorMessage: "the angle tips the face past vertical",
        result: {
          mesh: { positions: [], indices: [], faceIds: [] }, edges: [], bbox: { min: [0, 0, 0], max: [1, 1, 1] },
          bodies: [
            { id: "body1", name: "Plate", faceStart: 0, faceCount: 6 },
            { id: "body2", name: "Boss", faceStart: 6, faceCount: 3, fault: "open shell" },
          ],
        },
      },
      rollbackIndex: over.roll ?? 4,
      isSuppressed: (id: string) => (over.suppressed ?? []).includes(id),
      isBodyVisible: (id: string) => !(over.hidden ?? []).includes(id),
      // an assignment to a deleted material resolves to nothing, as bodyMaterialOf does
      bodyMaterialOf: (id: string) => (id === "body1" ? { id: "m-brass", name: "Brass" } : undefined),
      bodyColorSlot: (id: string) => (id === "body2" ? 2 : undefined),
      busyState: { active: false, label: "", id: null, pct: null, stage: null, rebuild: false, waiting: null, ...over.busy },
      previewError: null,
      canUndo: true,
      canRedo: false,
      dirty: true,
      fileName: "plate.funda",
    },
    viewport: {
      getSelectedBodies: () => [],
      getSelectedFaceIds: () => [7],
      selectedEdgeLines: () => [],
      faceIdToBodyId: (id: number) => (id >= 6 ? "body2" : "body1"),
    },
  } as unknown as read.ReadHost;
}

beforeEach(() => {
  setActivePinia(createPinia());
  clearLog();
  mountApp();
});
afterEach(() => vi.useRealTimers());

describe("history", () => {
  it("names each feature and says which failed, are suppressed or rolled back", () => {
    const h = read.history(host({ suppressed: ["e1"], roll: 3 }));
    expect(h.at).toBe("rolled back to 3");
    expect(h.rows.map((r) => [r.id, r.name, r.state])).toEqual([
      ["s1", "Sketch", ""],
      ["e1", "Plate", "suppressed"],
      ["d1", "Draft", "error: the angle tips the face past vertical"],
      ["f1", "Fillet", "rolled back"],
    ]);
  });
});

describe("history of an import", () => {
  const nodes = [{ name: "Gearbox", parent: null }, { name: "Shaft", parent: 0 }, { name: "Cover", parent: 0 }];
  const names = (features: object[]) => read.history(host({ features })).rows.map((r) => r.name);

  it("uses the assembly name Items shows, while the import still has the name of its file", () => {
    expect(names([
      { id: "i1", type: "import", format: "step", name: "gear-box_v3", source: "D:\\cad\\in\\Gear-Box_V3.step", nodes },
      { id: "i2", type: "import", format: "step", name: "pump", source: "/home/u/pump.stp.gz", nodes: [{ name: "Pump body", parent: null }] },
    ])).toEqual(["Gearbox", "Pump body"]);
  });

  it("keeps the name when it was typed, or the file or its tree cannot say otherwise", () => {
    expect(names([
      { id: "i1", type: "import", format: "step", name: "Housing", source: "/in/gear.step", nodes },
      { id: "i2", type: "import", format: "step", name: "gear", nodes },
      { id: "i3", type: "import", format: "step", name: "gear", source: "/in/gear.step", nodes: [{ name: "A", parent: null }, { name: "B", parent: null }] },
      { id: "i4", type: "import", format: "step", name: "gear", source: "/in/gear.step", nodes: [{ name: "", parent: null }] },
      { id: "i5", type: "import", format: "stl", name: "gear", source: "/in/gear.stl" },
      { id: "i6", type: "import", format: "step", name: "gear", source: "/in/gearbox.step", nodes },
    ])).toEqual(["Housing", "gear", "gear", "gear", "gear", "gear"]);
  });
});

describe("bodies and selection", () => {
  it("lists bodies with their face counts, visibility, material, colour and faults", () => {
    expect(read.bodies(host({ hidden: ["body2"] }))).toEqual([
      { id: "body1", name: "Plate", faces: 6, visible: true, material: "Brass", slot: null, fault: null },
      { id: "body2", name: "Boss", faces: 3, visible: false, material: null, slot: 2, fault: "open shell" },
    ]);
  });

  it("numbers a selected face within its body", () => {
    expect(read.selection(host()).faces).toEqual([["body2", 1]]);
  });
});

describe("status", () => {
  it("reads the mode, document and prompt", () => {
    const s = read.status(host());
    expect(s).toMatchObject({ mode: "model", doc: "Untitled", dirty: true, undo: true, redo: false, prompt: "Pick a face to draft" });
    expect(s.error).toBe("the angle tips the face past vertical");
    expect(s.warnings).toEqual([]);
  });

  it("names the sketch tool the rail has lit, a sketch shows no running tool button", () => {
    const rail = document.getElementById("toolrail")!;
    rail.dataset.mode = "sketch";
    rail.dataset.sketchTool = "line";
    expect(read.status(host()).tool).toBe("Line");
    rail.dataset.sketchTool = "fillet";
    expect(read.status(host()).tool).toBe("Fillet");
    rail.dataset.sketchTool = "move";
    expect(read.status(host()).tool).toBe("Move/Rotate");
    rail.dataset.sketchTool = "select";
    expect(read.status(host()).tool).toBeNull();
    rail.dataset.mode = "model";
    delete rail.dataset.sketchTool;
  });

  it("says what the app is busy with, an import's stage and how far it got", () => {
    expect(read.status(host()).busy).toBeNull();
    expect(read.status(host({ busy: { active: true, label: "Importing ender3.step", stage: "Transferring shapes", pct: 40.4 } })).busy)
      .toBe("Importing ender3.step, Transferring shapes 40%");
    expect(read.status(host({ building: true })).busy).toBe("building");
  });

  it("names a warning the view raised, such as Low performance", () => {
    document.body.insertAdjacentHTML("beforeend", `<div id="viewcontrols"><button class="perf-warn" title="Low performance"></button></div>`);
    expect(read.status(host()).warnings).toEqual(["Low performance"]);
    document.getElementById("viewcontrols")!.remove();
  });
});

describe("messages", () => {
  it("keeps an info toast after it has left the screen", () => {
    vi.useFakeTimers();
    const before = read.messages().seq;
    toast("Saved");
    vi.advanceTimersByTime(4000);
    expect(useToastStore().items).toHaveLength(0);
    const m = read.messages(before);
    expect(m.rows.map((r) => [r.level, r.text])).toEqual([["info", "Saved"]]);
    expect(read.messages(m.seq).rows).toEqual([]);
  });

  it("falls back to the newest logged error", () => {
    const h = host();
    (h.store.buildState as { errorMessage: string | null }).errorMessage = null;
    expect(read.lastError(h)).toBeNull();
    logError("the engine stopped");
    expect(read.lastError(h)).toBe("the engine stopped");
  });

  it("counts only what was logged after a step began", () => {
    const h = host();
    (h.store.buildState as { errorMessage: string | null }).errorMessage = null;
    logError("an old failure");
    toast("Saved");
    const mark = read.seq();
    expect(read.lastError(h, mark)).toBeNull();
    expect(read.status(h, document, mark)).toMatchObject({ recent: null, error: null });
    logError("a new failure");
    expect(read.lastError(h, mark)).toBe("a new failure");
    expect(read.status(h, document, mark).recent).toMatchObject({ level: "error", text: "a new failure" });
  });

  it("numbers an empty log from 0", () => {
    clearLog();
    expect(read.seq()).toBe(0);
    logError("x");
    expect(read.seq()).toBeGreaterThan(0);
  });
});
