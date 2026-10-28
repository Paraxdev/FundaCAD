// A fillet on a big preselection seeds its members from the selected edges themselves. Matching each one back to the
// model by geometry scanned every model edge per member, minutes on the main thread at 20,000 members.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { EdgeFeatureTool } from "../../src/features/edgeFeatureTool";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import { edgeSelectColor } from "../../src/viewport/highlight";

vi.mock("../../src/viewport/highlight", async (orig) => {
  const real = await orig<typeof import("../../src/viewport/highlight")>();
  return { ...real, edgeSelectColor: vi.fn(real.edgeSelectColor), edgeHoverColor: vi.fn(real.edgeHoverColor) };
});

function lenient<T extends object>(own: Record<string, unknown>): T {
  return new Proxy(own, {
    get: (t, k) => (k in t ? t[k as string] : () => undefined),
  }) as unknown as T;
}

function seeds(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const x = (i % 100) * 3,
      y = Math.floor(i / 100) * 3;
    const points: [number, number, number][] = [
      [x, y, 0],
      [x + 1, y, 0],
    ];
    return {
      sel: { kind: "edge", by: "nearest", point: [x + 0.5, y, 0], body: "b1" },
      line: { id: i, points, body: "b1" },
    };
  });
}

function rig(n: number) {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, -100, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const edgeLineForSelector = vi.fn(() => null);
  const edgeLineByMid = vi.fn(() => null);
  const pre = seeds(n);
  const vp = lenient<Viewport>({
    domElement: document.createElement("canvas"),
    camera,
    suspendPicking: false,
    selectedEdgeSeeds: () => pre,
    selectedEdgeCount: () => pre.length,
    selectedEdgeScope: () => ({ scope: "single" }),
    pixelWorldSize: () => 0.1,
    projectToScreen: () => ({ x: 100, y: 100 }),
    modelDiagonal: () => 500,
    edgeLineForSelector,
    edgeLineByMid,
    visibleEdgeLines: () => pre.map((p) => p.line),
    rayFrom: () => new THREE.Raycaster(new THREE.Vector3(0, -100, 0), new THREE.Vector3(0, 1, 0)),
  });
  let k = 0;
  const store = lenient<DocumentStore>({
    document: { features: [], parameters: {} },
    nextId: () => `f${++k}`,
    onBuild: () => () => {},
    isParamBound: () => false,
    bareParamRef: () => null,
  });
  return { tool: new EdgeFeatureTool(vp, store), edgeLineForSelector, edgeLineByMid };
}

describe("fillet on a big preselection", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => document.body.replaceChildren());

  it("keeps 5,000 members without matching any of them back by geometry", () => {
    const { tool, edgeLineForSelector, edgeLineByMid } = rig(5000);
    tool.start("fillet", () => {});
    expect(tool.memberRows().length).toBe(5000);
    expect(edgeLineForSelector).not.toHaveBeenCalled();
    expect(edgeLineByMid).not.toHaveBeenCalled();
    tool.cancel();
  });

  // Each colour reads the theme and converts through OKLCH, 0.16 ms a call, 3 s at 20,000 members.
  it("reads the member colour once for the whole seed and recolor, not once per member", () => {
    const { tool } = rig(5000);
    vi.mocked(edgeSelectColor).mockClear();
    tool.start("fillet", () => {});
    expect(vi.mocked(edgeSelectColor).mock.calls.length).toBeLessThanOrEqual(2);
    vi.mocked(edgeSelectColor).mockClear();
    (tool as unknown as { recolorGhosts(): void }).recolorGhosts();
    expect(vi.mocked(edgeSelectColor).mock.calls.length).toBeLessThanOrEqual(1);
    tool.cancel();
  });

  it("counts the preselection for the gate without seeding anything", () => {
    const { tool } = rig(4321);
    expect(tool.seedCount("fillet")).toBe(4321);
    expect(tool.memberRows().length).toBe(0);
  });
});
