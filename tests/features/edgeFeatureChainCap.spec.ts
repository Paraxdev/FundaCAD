// A chain scoped preselection grows by its tangent chains after the count gate saw only the selected edges, so the
// gate counts the chains and the tool refuses when they pass the cap.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { EdgeFeatureTool } from "../../src/features/edgeFeatureTool";
import { EDGE_CAP, confirmEdgeCount } from "../../src/features/edgeCountGate";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";

vi.mock("../../src/features/edgeCountGate", async (real) => ({
  ...(await real<typeof import("../../src/features/edgeCountGate")>()),
  confirmEdgeCount: vi.fn(async () => false),
}));

function lenient<T extends object>(own: Record<string, unknown>): T {
  return new Proxy(own, {
    get: (t, k) => (k in t ? t[k as string] : () => undefined),
  }) as unknown as T;
}

type P = [number, number, number];

/** `rows` straight runs of `len` unit edges, each run one tangent chain; `every`th edge of each run is selected. */
function rig(rows: number, len: number, every: number) {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, -100, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const all: { id: string; points: P[]; body: string }[] = [];
  const byMid = new Map<string, (typeof all)[number]>();
  const pre: { sel: unknown; line: (typeof all)[number] }[] = [];
  for (let r = 0; r < rows; r++)
    for (let x = 0; x < len; x++) {
      const line = {
        id: `e${all.length}`,
        points: [
          [x, r * 3, 0],
          [x + 1, r * 3, 0],
        ] as P[],
        body: "b1",
      };
      all.push(line);
      byMid.set(`${x + 0.5},${r * 3}`, line);
      if (x % every === 0)
        pre.push({ sel: { kind: "edge", by: "nearest", point: [x + 0.5, r * 3, 0], body: "b1" }, line });
    }
  const visibleEdgeLines = vi.fn(() => all);
  const vp = lenient<Viewport>({
    domElement: document.createElement("canvas"),
    camera,
    suspendPicking: false,
    selectedEdgeSeeds: () => pre,
    selectedEdgeCount: () => pre.length,
    selectedEdgeScope: () => ({ scope: "chain", reason: "tangent" }),
    pixelWorldSize: () => 0.1,
    projectToScreen: () => ({ x: 100, y: 100 }),
    modelDiagonal: () => 500,
    edgeLineForSelector: () => null,
    edgeLineByMid: (m: P) => byMid.get(`${m[0]},${m[1]}`) ?? null,
    visibleEdgeLines,
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
  return { tool: new EdgeFeatureTool(vp, store), visibleEdgeLines };
}

describe("fillet on a chain scoped preselection", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(confirmEdgeCount).mockClear();
  });
  afterEach(() => document.body.replaceChildren());

  it("counts the tangent chains of the selected edges for the gate", () => {
    const { tool } = rig(3, 60, 20);
    expect(tool.seedCount("fillet")).toBe(180);
  });

  it("expands every member's chain from one read of the model's edges", () => {
    const { tool, visibleEdgeLines } = rig(2, 60, 2);
    tool.start("fillet", () => {});
    expect(tool.memberRows().length).toBe(120);
    // One read walks every chain, the other measures the clearance.
    expect(visibleEdgeLines.mock.calls.length).toBeLessThanOrEqual(2);
    tool.cancel();
  });

  it("takes chains of exactly the cap", () => {
    const { tool } = rig(2, EDGE_CAP / 2, EDGE_CAP / 2);
    const done = vi.fn();
    tool.start("fillet", done);
    expect(done).not.toHaveBeenCalled();
    expect(tool.memberRows().length).toBe(EDGE_CAP);
    expect(confirmEdgeCount).not.toHaveBeenCalled();
    tool.cancel();
  });

  it("refuses and closes when the chains pass the cap by one edge", () => {
    const { tool } = rig(1, EDGE_CAP + 1, EDGE_CAP + 1);
    const done = vi.fn();
    tool.start("fillet", done);
    expect(done).toHaveBeenCalledWith(null);
    expect(tool.memberRows().length).toBe(0);
    expect(confirmEdgeCount).toHaveBeenCalledWith("Fillet", EDGE_CAP + 1);
  });
});
