// A second extrude of a consumed sketch starts from a profile lying on the solid
// its first extrude made, so the direction guess reads Cut and a shallow drag
// shaved that body. It is held to New body instead, until Alt+O changes it, and
// the drag never flips it back.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createPinia, setActivePinia } from "pinia";
import { ExtrudeTool } from "../../src/features/extrudeTool";
import { usePromptStore } from "../../src/stores/prompt";

interface Internals {
  distance: number;
  promptKey: string;
  refreshPrompt(): void;
  buildFeature(): { operation: string };
}

const tools: ExtrudeTool[] = [];

function rig() {
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const wr = {
    sketchId: "f1",
    interior3D: new THREE.Vector3(1, 1, 0),
    plane: { n: new THREE.Vector3(0, 0, 1), plane, to2D: () => new THREE.Vector2(), to3D: () => new THREE.Vector3() },
    region: { loop: [] },
  };
  let selected: unknown[] = [];
  const overlay = {
    regions: [],
    update: vi.fn(),
    regionPointsForSketch: () => [[1, 1, 0]],
    selectRegionsByPoints: () => { selected = [wr]; },
    selectedRegions: () => selected,
    setHoverRegion: vi.fn(),
    clearRegionSelection: () => { selected = []; },
  };
  const addFeature = vi.fn();
  const store = {
    document: { features: [{ id: "f1", type: "sketch" }, { id: "f2", type: "extrude", sketch: "f1", distance: 20 }] },
    buildState: { result: { mesh: { positions: [0, 0, 0] } } },
    nextId: () => "f9",
    hiddenBodyIds: () => undefined,
    addFeature,
  };
  const canvas = document.createElement("canvas");
  const viewport = {
    domElement: canvas,
    suspendPicking: false,
    // every probe lands in material, both ways: the guess would be Cut
    pointInSolid: () => true,
    requestRender: vi.fn(),
    setPeek: vi.fn(),
    removeFromScene: vi.fn(),
  };
  const tool = new ExtrudeTool(viewport as never, overlay as never, store as never);
  tools.push(tool);
  const t = tool as unknown as Internals;
  const dragTo = (d: number) => {
    t.distance = d;
    t.promptKey = "";
    t.refreshPrompt();
  };
  return { tool, t, dragTo, addFeature };
}

beforeEach(() => {
  setActivePinia(createPinia());
  const proto = ExtrudeTool.prototype as unknown as { updatePreview(): void; positionDim(): void };
  vi.spyOn(proto, "updatePreview").mockImplementation(function (this: Internals) { this.refreshPrompt(); });
  vi.spyOn(proto, "positionDim").mockImplementation(() => {});
});
afterEach(() => {
  // a tool left armed keeps its window keydown listener, which would answer the
  // next test's Alt+O
  for (const tool of tools.splice(0)) if ((tool as unknown as { active: boolean }).active) tool.cancel();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const altO = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "o", code: "KeyO", altKey: true }));

describe("extruding a consumed sketch chosen in the tree", () => {
  it("defaults to a new body where the direction says cut", () => {
    const r = rig();
    expect(r.tool.start(() => {}, { sketch: "f1" })).toBe(true);
    expect(r.t.buildFeature().operation).toBe("new");
    expect(usePromptStore().text).toMatch(/^New body · Alt\+O operation/);
  });

  it("keeps the new body through a drag both ways", () => {
    const r = rig();
    r.tool.start(() => {}, { sketch: "f1" });
    for (const d of [3, 12, -4, -30, 6]) {
      r.dragTo(d);
      expect(r.t.buildFeature().operation).toBe("new");
    }
    r.tool.cancel();
  });

  it("takes the user's operation from Alt+O and keeps it through a drag", () => {
    const r = rig();
    r.tool.start(() => {}, { sketch: "f1" });
    altO(); // join
    expect(r.t.buildFeature().operation).toBe("join");
    altO(); // cut
    for (const d of [3, -8, 25]) {
      r.dragTo(d);
      expect(r.t.buildFeature().operation).toBe("cut");
    }
    expect(usePromptStore().text).toMatch(/^Cut · Alt\+O operation/);
    altO(); // back round to new
    r.dragTo(-2);
    expect(r.t.buildFeature().operation).toBe("new");
    r.tool.cancel();
  });

  it("commits what the user settled on", () => {
    const r = rig();
    r.tool.start(() => {}, { sketch: "f1" });
    altO();
    r.dragTo(7);
    (r.tool as unknown as { commit(): void }).commit();
    expect(r.addFeature).toHaveBeenCalledTimes(1);
    expect(r.addFeature.mock.calls[0]![0]).toMatchObject({ type: "extrude", sketch: "f1", operation: "join", distance: 7 });
  });

  it("an ordinary extrude still guesses from the direction, and ignores Alt+O", () => {
    const r = rig();
    // a profile picked in the view, not a consumed sketch from the tree
    (r.tool as unknown as { overlay: { selectRegionsByPoints(p: unknown): void } }).overlay.selectRegionsByPoints([]);
    r.tool.start(() => {});
    expect(r.t.buildFeature().operation).toBe("cut");
    altO();
    r.dragTo(5);
    expect(r.t.buildFeature().operation).toBe("cut");
    expect(usePromptStore().text).not.toMatch(/Alt\+O/);
    r.tool.cancel();
  });
});
