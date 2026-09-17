// The toolbox's real activate() against a faked engine: what it adds, how a pick becomes a feature,
// and that switching it off takes all of it away.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { activate } from "../../plugins/FundaCAD.PrintToolbox/main";
import {
  anyToolBusy, contributedAction, contributedRibbon, contributors, resetContributions,
} from "../../src/plugins/contrib";
import { applicableTools } from "../../src/features/toolCapabilities";
import { iconPaths } from "../../src/ui/icons";
import { featureMeta } from "../../src/ui/featureMeta";
import { choiceFieldsFor, fieldApplies, toggleFieldsFor } from "../../src/document/optionFields";
import { targetsOf } from "../../src/features/selectionTargets";
import type { Engine } from "../../src/app/engine";

function fakeEngine() {
  const state = {
    faces: [] as { point: [number, number, number]; faceId: number }[],
    bodies: [] as string[],
    hasBody: true,
    status: "",
    dir: "+Z",
    added: [] as Record<string, unknown>[],
    bbox: null as { min: [number, number, number]; max: [number, number, number] } | null,
  };
  const viewport = {
    setSelectionMode: vi.fn(),
    clearSelection: () => { state.faces = []; },
    faceIdToBodyId: (id: number) => `body${id}`,
    getSelectedBodies: () => state.bodies,
    get draftConfig() { return { dir: state.dir, threshold: 45 }; },
    selectedFacesForPressPull: () => state.faces.length
      ? {
        selectors: state.faces.map((f) => ({ kind: "face", by: "nearest", point: f.point })),
        faceIds: state.faces.map((f) => f.faceId),
      }
      : null,
  };
  const store = {
    nextId: () => `f${state.added.length + 1}`,
    addFeature: (f: Record<string, unknown>) => { state.added.push(f); },
    get buildState() { return { result: state.bbox ? { bbox: state.bbox } : null }; },
  };
  const e = {
    viewport,
    store,
    toolBusy: () => false,
    hasBody: () => state.hasBody,
    setStatus: (t: string) => { state.status = t; },
    noteCommitted: vi.fn(),
    selectFeature: vi.fn(),
  };
  return { e: e as unknown as Engine, state, calls: e };
}

function press(key: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("the 3D Printing Toolbox, switched on and off", () => {
  let stop: () => void;
  let engine: ReturnType<typeof fakeEngine>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    engine = fakeEngine();
    stop = await activate(engine.e);
  });

  afterEach(() => {
    stop();
    resetContributions();
  });

  it("adds eight tools and a bed fit check, in a PRINT ribbon group, with marks", () => {
    expect(contributors()).toEqual(["FundaCAD.PrintToolbox"]);
    const faceIds = ["print-teardrop", "print-roof-bridge", "print-counterbore-bridge", "print-sacrificial-layer",
      "print-thread-ribs", "print-zip-tie-channel"];
    const bodyIds = ["print-elephant-foot-chamfer", "print-vertical-fillet"];
    for (const id of faceIds) {
      expect(applicableTools({ face: 1 })).toContain(id);
      expect(contributedAction(id)).toBeTypeOf("function");
    }
    for (const id of bodyIds) {
      expect(applicableTools({ body: 1 })).toContain(id);
      expect(applicableTools({ face: 1 })).not.toContain(id);
      expect(contributedAction(id)).toBeTypeOf("function");
    }
    const group = contributedRibbon().find((g) => g.group === "PRINT");
    expect(group?.items.map((i) => i.action)).toEqual([...faceIds, ...bodyIds, "print-bed-fit-check"]);
    expect(iconPaths("printTeardrop")).toContain("<path");
    expect(iconPaths("printBedFit")).toContain("<rect");
  });

  it("describes the features it leaves in the history", () => {
    expect(featureMeta({ type: "teardropHole" })).toEqual({ icon: "printTeardrop", label: "Teardrop" });
    expect(choiceFieldsFor("teardropHole").map((c) => c.field)).toEqual(["buildDir", "roof"]);
    expect(fieldApplies("teardropHole", "flatHeight", { roof: "pointed" })).toBe(false);
    expect(targetsOf("sacrificialLayer").map((t) => t.field)).toEqual(["faces"]);
    expect(targetsOf("elephantFootChamfer").map((t) => t.field)).toEqual(["bodies"]);
    expect(toggleFieldsFor("zipTieChannel").map((t) => t.field)).toEqual(["allowBreakthrough"]);
    expect(toggleFieldsFor("verticalFillet").map((t) => t.field)).toEqual(["onlyConvex"]);
  });

  it("acts at once on the selected bodies, with no wait, no pick and no clearing", () => {
    engine.state.bodies = ["b1", "b2"];
    engine.state.dir = "-Z";
    contributedAction("print-elephant-foot-chamfer")!();
    expect(engine.state.added).toEqual([{
      id: "f1", type: "elephantFootChamfer", bodies: ["b1", "b2"], size: 0.4, buildDir: "-Z",
    }]);
    expect(anyToolBusy()).toBe(false);
    expect(engine.calls.selectFeature).toHaveBeenCalledWith("f1");
  });

  it("leaves the body list off the feature when nothing is selected, for the active-body fallback", () => {
    contributedAction("print-vertical-fillet")!();
    expect(engine.state.added).toEqual([{ id: "f1", type: "verticalFillet", radius: 2, buildDir: "+Z" }]);
    expect(engine.state.added[0]).not.toHaveProperty("bodies");
  });

  it("bed fit check asks to build first when there is nothing to measure", async () => {
    await contributedAction("print-bed-fit-check")!();
    expect(engine.state.status).toContain("build the model first");
  });

  it("acts at once on faces already selected, with the Overhang build direction", () => {
    engine.state.faces = [{ point: [0, 0, 13], faceId: 4 }];
    engine.state.dir = "+X";
    contributedAction("print-teardrop")!();
    expect(engine.state.added).toEqual([{
      id: "f1", type: "teardropHole",
      faces: { kind: "face", by: "nearest", point: [0, 0, 13], body: "body4" },
      angle: 45, roof: "pointed", flatHeight: 0, buildDir: "+X",
    }]);
    expect(anyToolBusy()).toBe(false);
    expect(engine.calls.selectFeature).toHaveBeenCalledWith("f1");
  });

  it("waits for a pick and Enter when nothing is selected, and holds the window meanwhile", () => {
    contributedAction("print-roof-bridge")!();
    expect(anyToolBusy()).toBe(true);
    press("Enter");
    expect(engine.state.added).toHaveLength(0);
    expect(anyToolBusy()).toBe(true);
    engine.state.faces = [{ point: [1, 1, 1], faceId: 2 }, { point: [2, 2, 2], faceId: 3 }];
    press("Enter");
    expect(engine.state.added).toHaveLength(1);
    expect(engine.state.added[0]!["type"]).toBe("roofBridge");
    expect((engine.state.added[0]!["faces"] as unknown[])).toHaveLength(2);
    expect(anyToolBusy()).toBe(false);
  });

  it("lets Escape out of a pick without adding anything", () => {
    contributedAction("print-sacrificial-layer")!();
    press("Escape");
    expect(anyToolBusy()).toBe(false);
    expect(engine.state.added).toHaveLength(0);
    expect(engine.calls.noteCommitted).toHaveBeenCalledWith(null);
  });

  it("refuses an empty document and says why", () => {
    engine.state.hasBody = false;
    contributedAction("print-counterbore-bridge")!();
    expect(anyToolBusy()).toBe(false);
    expect(engine.state.status).toContain("create or import a body first");
  });

  it("takes everything away when switched off, mid-pick included", () => {
    contributedAction("print-teardrop")!();
    stop();
    expect(anyToolBusy()).toBe(false);
    expect(contributedAction("print-teardrop")).toBeNull();
    expect(featureMeta({ type: "teardropHole" })).not.toEqual({ icon: "printTeardrop", label: "Teardrop" });
    engine.state.faces = [{ point: [0, 0, 0], faceId: 1 }];
    press("Enter");
    expect(engine.state.added).toHaveLength(0);
  });
});
