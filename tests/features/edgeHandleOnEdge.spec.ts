// With several edges picked, the fillet handle stands on the most recently picked edge, at its middle and across it,
// rather than at the average of the edges, which for a box's top edges floats over the face on no geometry.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { EdgeFeatureTool } from "../../src/features/edgeFeatureTool";
import { edgeNudgePlacement } from "../../src/features/edgeNudge";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { EdgeRef } from "../../src/viewport/edgeLines";
import type { Feature } from "../../src/types";

type Vec3 = [number, number, number];

function lenient<T>(own: Record<string, unknown>): T {
  return new Proxy(own, {
    get: (t, k) => (k in t ? t[k as string] : () => undefined),
  }) as unknown as T;
}

// A 20 x 10 x 6 box turned 30 degrees about Z and 20 about X, centred at (30, -20, 15).
const CENTRE = new THREE.Vector3(30, -20, 15);
const TURN = new THREE.Quaternion().setFromEuler(new THREE.Euler((20 * Math.PI) / 180, 0, (30 * Math.PI) / 180, "ZXY"));
const place = (x: number, y: number, z: number): Vec3 =>
  new THREE.Vector3(x, y, z).applyQuaternion(TURN).add(CENTRE).toArray() as Vec3;
const TOP: Vec3[][] = [
  [place(-10, -5, 3), place(10, -5, 3)],
  [place(10, -5, 3), place(10, 5, 3)],
  [place(10, 5, 3), place(-10, 5, 3)],
  [place(-10, 5, 3), place(-10, -5, 3)],
];
const edgeRef = (pts: Vec3[], i: number): EdgeRef =>
  ({ id: `e${i}`, body: "b1", points: pts, smooth: false }) as unknown as EdgeRef;
const EDGES = TOP.map(edgeRef);
const mid = (pts: Vec3[]): Vec3 => pts[0]!.map((c, k) => (c + pts[1]![k]!) / 2) as Vec3;
const dir = (pts: Vec3[]) => new THREE.Vector3(...pts[1]!).sub(new THREE.Vector3(...pts[0]!)).normalize();

const round = (v: ArrayLike<number>) => Array.from(v, (c) => Math.round(c * 1e4) / 1e4 + 0);

function camera() {
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(80, -120, 90);
  cam.lookAt(CENTRE);
  cam.updateMatrixWorld(true);
  return cam;
}

/** Across the edge on screen and away from the box, the direction the handle measures a radius along. */
function expectAcrossAndOut(axis: THREE.Vector3, edge: Vec3[], anchor: THREE.Vector3) {
  expect(Math.abs(axis.dot(dir(edge)))).toBeLessThan(1e-9);
  expect(axis.dot(anchor.clone().sub(CENTRE))).toBeGreaterThan(0);
  expect(axis.length()).toBeCloseTo(1, 9);
}

describe("the passive edge handle", () => {
  const vp = lenient<Viewport>({ camera: camera() });

  for (const n of [1, 2, 4]) {
    it(`stands on the last of ${n} picked edge${n > 1 ? "s" : ""}, at its middle, across it`, () => {
      const picked = EDGES.slice(0, n);
      const p = edgeNudgePlacement(picked, () => {}, CENTRE)!;
      const last = TOP[n - 1]!;
      expect(round(p.anchor.toArray())).toEqual(round(mid(last)));
      expectAcrossAndOut(p.axis(vp), last, p.anchor);
    });
  }
});

describe("the fillet tool's handle", () => {
  let tools: EdgeFeatureTool[] = [];
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    for (const t of tools) if (t.active) t.cancel();
    tools = [];
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  function setup(picked: number) {
    const canvas = document.createElement("canvas");
    const byMid = (p: Vec3) => EDGES.find((e) => round(mid(e.points as Vec3[])).join() === round(p).join()) ?? null;
    const vp = lenient<Viewport>({
      domElement: canvas,
      camera: camera(),
      suspendPicking: false,
      selectedEdgeSelectors: () =>
        EDGES.slice(0, picked).map((e) => ({
          kind: "edge",
          by: "nearest",
          point: mid(e.points as Vec3[]),
          body: "b1",
        })),
      selectedEdgeScope: () => ({ scope: "single" }),
      edgeLineForSelector: (p: Vec3) => byMid(p),
      edgeLineByMid: (p: Vec3) => byMid(p),
      visibleEdgeLines: () => EDGES,
      pixelWorldSize: () => 0.1,
      projectToScreen: () => ({ x: 0, y: 0 }),
      modelDiagonal: () => 100,
      snapStep: () => 0.5,
    });
    const added: Feature[] = [];
    const store = lenient<DocumentStore>({
      document: { features: [], parameters: {} },
      nextId: () => "f1",
      onBuild: () => () => {},
      isParamBound: () => false,
      bareParamRef: () => null,
      addFeature: (f: Feature) => added.push(f),
      buildState: {
        building: false,
        result: { bbox: { min: CENTRE.clone().subScalar(1).toArray(), max: CENTRE.clone().addScalar(1).toArray() } },
      },
    });
    const tool = new EdgeFeatureTool(vp, store);
    tools.push(tool);
    tool.start("fillet", () => {});
    const state = tool as unknown as { anchor: THREE.Vector3; axis: THREE.Vector3 };
    return { tool, state, canvas, added };
  }

  for (const n of [1, 2, 4]) {
    it(`opens on the last of ${n} picked edge${n > 1 ? "s" : ""}, at its middle, across it`, () => {
      const t = setup(n);
      const last = TOP[n - 1]!;
      expect(round(t.state.anchor.toArray())).toEqual(round(mid(last)));
      expectAcrossAndOut(t.state.axis, last, t.state.anchor);
    });
  }

  it("moves to an edge picked while the tool is open", () => {
    const t = setup(2);
    Object.assign(t.tool, { clickTarget: () => ({ kind: "edge", hit: { edge: EDGES[3] } }) });
    // Shift takes the one edge, not its tangent chain.
    t.canvas.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 5, clientY: 5, button: 0, shiftKey: true, bubbles: true }),
    );
    expect(round(t.state.anchor.toArray())).toEqual(round(mid(TOP[3]!)));
    expectAcrossAndOut(t.state.axis, TOP[3]!, t.state.anchor);
  });

  it("stays on a picked edge, the nearest, when the newest one is taken off", () => {
    const t = setup(4);
    const ghosts = (t.tool as unknown as { ghosts: { mid: Vec3 }[] }).ghosts;
    const newest = ghosts.find((g) => round(g.mid).join() === round(mid(TOP[3]!)).join());
    expect(newest).toBeDefined();
    Object.assign(t.tool, { clickTarget: () => ({ kind: "member", g: newest }) });
    t.canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: 5, clientY: 5, button: 0, bubbles: true }));
    expect((t.tool as unknown as { ghosts: unknown[] }).ghosts).toHaveLength(3);
    // The nearest of the three left to where the taken off edge was.
    const left = [TOP[0]!, TOP[2]!].map((e) => round(mid(e)).join());
    expect(left).toContain(round(t.state.anchor.toArray()).join());
  });

  it("a drag on the handle still sizes every picked edge", () => {
    const t = setup(4);
    Object.assign(t.tool, {
      hitGizmo: () => true,
      swipeProj: (_x: number, y: number) => y / 10,
      limit: () => Infinity,
    });
    const at = (type: string, y: number) =>
      t.canvas.dispatchEvent(new PointerEvent(type, { clientX: 0, clientY: y, button: 0, bubbles: true }));
    at("pointerdown", 0);
    at("pointermove", 15);
    at("pointerup", 15);
    document
      .querySelector<HTMLInputElement>(".dim-input input")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const edges = TOP.map((e) => ({ kind: "edge", by: "nearest", point: mid(e), body: "b1" }));
    expect(t.added).toHaveLength(1);
    const f = t.added[0] as unknown as { type: string; radius: number; edges: { point: Vec3 }[] };
    expect({ type: f.type, edges: f.edges.map((e) => ({ ...e, point: round(e.point) })) }).toEqual({
      type: "fillet",
      edges: edges.map((e) => ({ ...e, point: round(e.point) })),
    });
    expect(f.radius).toBeGreaterThan(0);
  });
});
