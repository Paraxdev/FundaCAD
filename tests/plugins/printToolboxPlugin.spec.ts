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
import { choiceFieldsFor, fieldApplies } from "../../src/document/optionFields";
import { targetsOf } from "../../src/features/selectionTargets";
import type { Engine } from "../../src/app/engine";

function fakeEngine() {
  const state = {
    faces: [] as { point: [number, number, number]; faceId: number }[],
    hasBody: true,
    status: "",
    dir: "+Z",
    added: [] as Record<string, unknown>[],
  };
  const viewport = {
    setSelectionMode: vi.fn(),
    clearSelection: () => { state.faces = []; },
    faceIdToBodyId: (id: number) => `body${id}`,
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

  it("adds four tools a face selection is offered, in a PRINT ribbon group, with marks", () => {
    expect(contributors()).toEqual(["FundaCAD.PrintToolbox"]);
    const ids = ["print-teardrop", "print-roof-bridge", "print-counterbore-bridge", "print-sacrificial-layer"];
    for (const id of ids) {
      expect(applicableTools({ face: 1 })).toContain(id);
      expect(contributedAction(id)).toBeTypeOf("function");
    }
    const group = contributedRibbon().find((g) => g.group === "PRINT");
    expect(group?.items.map((i) => i.action)).toEqual(ids);
    expect(iconPaths("printTeardrop")).toContain("<path");
  });

  it("describes the features it leaves in the history", () => {
    expect(featureMeta({ type: "teardropHole" })).toEqual({ icon: "printTeardrop", label: "Teardrop" });
    expect(choiceFieldsFor("teardropHole").map((c) => c.field)).toEqual(["buildDir", "roof"]);
    expect(fieldApplies("teardropHole", "flatHeight", { roof: "pointed" })).toBe(false);
    expect(targetsOf("sacrificialLayer").map((t) => t.field)).toEqual(["faces"]);
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
