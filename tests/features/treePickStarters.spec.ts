// A pick the tool is waiting for, answered from an Items row instead of the view.
// MO-3: Offset Plane, "Select a plane or face to offset from", the YZ row clicked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createPinia, setActivePinia } from "pinia";
import { createFeatureStarters, type FeatureStartersDeps } from "../../src/features/featureStarters";
import { endRewoundPick, resetTreePicks, routeTreeClick, treePickWaiting, type TreePick } from "../../src/ui/treePick";
import { createActions } from "../../src/app/actions";
import { DocumentStore } from "../../src/document/store";
import type { Engine } from "../../src/app/engine";
import type { GeometryBackend } from "../../src/geometry/client";
import { usePromptStore } from "../../src/stores/prompt";
import { ZERO_POSE } from "../../src/document/datumPose";
import type { PlaneDef, Vec3 } from "../../src/types";
import type { EdgeRef } from "../../src/viewport/edgeLines";
import { axisFromEdge, cylinderFromFace } from "../../src/features/planeMath";
import { asVec, CYL_ANCHOR, faceRowViewport } from "./faceRowRig";

const answers = vi.hoisted(() => ({ queue: [] as unknown[] }));
vi.mock("../../src/ui/choice", () => ({ choose: async () => answers.queue.shift() ?? null }));

let frames: (() => void)[] = [];
const flushFrame = () => {
  const run = frames;
  frames = [];
  for (const f of run) f();
};

function rig(bodies: { id: string; name: string }[] = []) {
  let planePick = false;
  const canvas = document.createElement("canvas");
  const datumPoseStart = vi.fn();
  const addFeature = vi.fn();
  const viewport = {
    domElement: canvas,
    suspendPicking: false,
    showAllPlanes: vi.fn(),
    clearHover: () => {},
    hoverDatum: () => {},
    hoverBody: () => {},
    setPickMarkers: vi.fn(),
    selectedFaceSketchPlane: () => null,
    getSelectedBodies: () => [],
    setSelectedBodies: vi.fn(),
  };
  const deps = {
    store: {
      document: { parameters: {}, features: [] },
      buildState: { result: { bodies, mesh: { positions: bodies.length ? [0] : [] } } },
      nextId: () => "f9",
      addFeature,
    },
    viewport,
    overlay: { regions: [], selectedRegions: () => [] },
    sketch: { enter: vi.fn() },
    datumPose: { start: datumPoseStart },
    canvas,
    toolBusy: () => planePick,
    hasBody: () => bodies.length > 0,
    setStatus: vi.fn(),
    selectFeature: vi.fn(),
    noteCommitted: vi.fn(),
    isSketchConsumed: () => false,
    getSelectedFeature: () => null,
    setPlanePick: (v: boolean) => {
      planePick = v;
    },
    datumMoveTarget: () => null,
  } as unknown as FeatureStartersDeps;
  const starters = createFeatureStarters(deps);
  const hints: string[] = [];
  const click = (pick: TreePick) => routeTreeClick(pick, { busyHint: () => null, hint: (t) => hints.push(t) });
  return { starters, deps, datumPoseStart, addFeature, viewport, hints, click, planePick: () => planePick };
}

beforeEach(() => {
  setActivePinia(createPinia());
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => {
    frames.push(f);
    return frames.length;
  });
});
afterEach(() => {
  answers.queue = [];
  resetTreePicks();
  vi.unstubAllGlobals();
});

describe("a tool's pick answered from the Items tree", () => {
  it("Offset Plane takes the YZ row as its reference plane", () => {
    const r = rig();
    r.starters.offsetPlane();
    expect(usePromptStore().text).toBe("Select a plane or face to offset from");
    expect(r.click({ kind: "basePlane", plane: "YZ" })).toBe("taken");
    // the pick is over at once, exactly as a click on the quad ends it
    expect(r.planePick()).toBe(false);
    expect(treePickWaiting()).toBe(false);
    expect(usePromptStore().text).toBeNull();
    flushFrame();
    expect(r.datumPoseStart).toHaveBeenCalledTimes(1);
    expect(r.datumPoseStart.mock.calls[0]![0]).toMatchObject({ src: "YZ" });
  });

  it("a datum plane row carries its id, so the new plane hangs off that datum", () => {
    const r = rig();
    r.starters.offsetPlane();
    const def: PlaneDef = { origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] };
    r.click({ kind: "datumPlane", id: "dp", def });
    flushFrame();
    const [pose, done] = r.datumPoseStart.mock.calls[0]! as [unknown, (p: unknown) => void];
    expect(pose).toMatchObject({ src: def });
    done({ ...ZERO_POSE, offset: 3 });
    expect(r.addFeature.mock.calls[0]![0]).toMatchObject({ type: "datumPlane", plane: def, planeId: "dp" });
  });

  it("a row the pick cannot use is refused with a hint and the pick stays open", () => {
    const r = rig();
    r.starters.offsetPlane();
    expect(r.click({ kind: "body", id: "b1" })).toBe("refused");
    expect(r.hints).toEqual(["That row is a body, this step needs a plane or a face"]);
    expect(r.planePick()).toBe(true);
    expect(treePickWaiting()).toBe(true);
    expect(usePromptStore().text).toBe("Select a plane or face to offset from");
    // and still answers the right row afterwards
    expect(r.click({ kind: "basePlane", plane: "XZ" })).toBe("taken");
  });

  it("Escape ends the wait, so a later row click is the row's own again", () => {
    const r = rig();
    r.starters.offsetPlane();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(treePickWaiting()).toBe(false);
    expect(r.click({ kind: "basePlane", plane: "YZ" })).toBe("row");
  });

  it("a point pick takes a datum point row as one of its points", () => {
    const r = rig();
    r.starters.createDatumPoint();
    r.click({ kind: "datumPoint", id: "p1", point: [4, 5, 6] });
    flushFrame();
    expect(r.addFeature.mock.calls[0]![0]).toMatchObject({ type: "datumPoint", point: [4, 5, 6] });
  });

  it("a point pick refuses a face or edge row by naming the datum point row it takes, and keeps the count", () => {
    const r = rig();
    r.starters.createPlaneThroughPoints();
    expect(r.click({ kind: "face", faceId: 9 })).toBe("refused");
    expect(r.click({ kind: "edge", edge: { id: "b2:3", body: "b2", points: [] } as never })).toBe("refused");
    expect(r.hints).toHaveLength(2);
    for (const h of r.hints) expect(h).toContain("datum point");
    expect(usePromptStore().text).toContain("0 of 3");
    expect(r.click({ kind: "datumPoint", id: "p2", point: [7, -3, 5] })).toBe("taken");
    expect(usePromptStore().text).toContain("1 of 3");
    expect(treePickWaiting()).toBe(true);
  });

  it("a boolean takes body rows, and refuses the body it already has", () => {
    const r = rig([
      { id: "b1", name: "A" },
      { id: "b2", name: "B" },
    ]);
    r.starters.startBoolean("subtract");
    expect(r.click({ kind: "body", id: "b1" })).toBe("taken");
    flushFrame();
    expect(r.click({ kind: "body", id: "b1" })).toBe("refused");
    expect(r.click({ kind: "body", id: "b2" })).toBe("taken");
    flushFrame();
    expect(r.addFeature.mock.calls[0]![0]).toMatchObject({
      type: "boolean",
      operation: "subtract",
      target: "b1",
      tools: ["b2"],
    });
  });
});

// The review's two leaks: a body pick that did not mark the screen busy, so a
// second command started over it and its taker came back later; and undo,
// which never touched the pick at all. Either way Box then Cylinder rows,
// clicked long after, committed a boolean nobody asked for.
describe("a pick session cannot outlive its tool", () => {
  const stubBackend = {
    async rebuild() {
      return { ok: false, error: { message: "stub" } };
    },
    async init() {},
    onStatus() {
      return () => {};
    },
    connected: true,
  } as unknown as GeometryBackend;

  function actionsOver(r: ReturnType<typeof rig>) {
    const d = r.deps as unknown as Record<string, unknown>;
    return createActions({
      sketch: { active: false },
      starters: r.starters,
      tools: { section: { picking: false, active: false } },
      toolBusy: d.toolBusy,
      setStatus: d.setStatus,
      lastAction: null,
    } as unknown as Engine);
  }

  const noBoolean = (r: ReturnType<typeof rig>) =>
    r.addFeature.mock.calls.every(([f]) => (f as { type: string }).type !== "boolean");

  it("a body pick holds the screen, so a starter called over it does nothing", () => {
    const r = rig([
      { id: "b1", name: "A" },
      { id: "b2", name: "B" },
    ]);
    r.starters.startBoolean("subtract");
    expect(r.planePick()).toBe(true);
    r.starters.offsetPlane();
    expect(usePromptStore().text).toBe("Click the body to keep · Esc cancels");
  });

  it("a command started over a body pick ends it, and later body rows commit nothing", () => {
    const r = rig([
      { id: "b1", name: "A" },
      { id: "b2", name: "B" },
    ]);
    const act = actionsOver(r);
    r.starters.startBoolean("subtract");
    act("revolve");
    expect(r.planePick()).toBe(false);
    expect(treePickWaiting()).toBe(false);
    expect(r.click({ kind: "body", id: "b1" })).toBe("row");
    flushFrame();
    expect(r.click({ kind: "body", id: "b2" })).toBe("row");
    flushFrame();
    expect(noBoolean(r)).toBe(true);
  });

  it("a look around the model keeps the pick", () => {
    const r = rig([
      { id: "b1", name: "A" },
      { id: "b2", name: "B" },
    ]);
    r.starters.startBoolean("subtract");
    try {
      actionsOver(r)("persp");
    } catch {
      /* the fake has no viewport, only the pick matters */
    }
    expect(treePickWaiting()).toBe(true);
  });

  it("undo mid pick ends it through its cleanup, and later body rows commit nothing", () => {
    const r = rig([
      { id: "b1", name: "A" },
      { id: "b2", name: "B" },
    ]);
    const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
    store.onRewind(endRewoundPick);
    store.addFeature({ id: "x", type: "box", length: 1, width: 1, height: 1 } as never);
    r.starters.startBoolean("subtract");
    store.undo();
    expect(r.planePick()).toBe(false);
    expect(usePromptStore().text).toBeNull();
    expect(r.click({ kind: "body", id: "b1" })).toBe("row");
    expect(r.click({ kind: "body", id: "b2" })).toBe("row");
    flushFrame();
    expect(noBoolean(r)).toBe(true);
  });

  it("redo, a load and a new document end it too", () => {
    const r = rig([{ id: "b1", name: "A" }]);
    const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
    store.onRewind(endRewoundPick);
    store.addFeature({ id: "x", type: "box", length: 1, width: 1, height: 1 } as never);
    store.undo();
    for (const replace of [
      () => store.redo(),
      () => store.load(JSON.stringify({ parameters: {}, features: [] })),
      () => store.newDocument(),
    ]) {
      r.starters.offsetPlane();
      expect(treePickWaiting()).toBe(true);
      replace();
      expect(treePickWaiting()).toBe(false);
      expect(r.planePick()).toBe(false);
    }
  });
});

describe("a face or an edge row from the Geometry list", () => {
  const slanted: PlaneDef = { origin: [12.5, -7.25, 30], normal: [0, 0.6, 0.8], xdir: [1, 0, 0] };
  const anchor = {
    selector: { kind: "face", by: "nearest", point: [12.5, -7.25, 30], body: "b2" },
    at: [12.5, -7.25, 30],
  };
  const faceSel = (id: number) => ({
    kind: "face",
    by: "nearest",
    point: [id + 0.5, -7.25, 30],
    body: id > 20 ? "b3" : "b2",
  });
  function lidRig() {
    const r = rig([
      { id: "b2", name: "Lid" },
      { id: "b3", name: "Base" },
    ]);
    const showSketchFace = vi.fn();
    Object.assign(r.viewport, {
      faceSketchPlane: (id: number) => (id === 14 ? { plane: slanted, faceId: 14, anchor } : null),
      showSketchFace,
      planarFace: () => null,
      faceSelectorOf: faceSel,
      emphasizeEdges: () => {},
      hoverEdge: () => {},
    });
    return { ...r, showSketchFace };
  }
  const edgeRow = (points: Vec3[]) =>
    ({ kind: "edge", edge: { id: "b2:3", body: "b2", points, smooth: false, slot: 3 } as unknown as EdgeRef }) as const;

  it("Sketch starts on a flat face row's plane and follows that face", () => {
    const r = lidRig();
    r.starters.startSketch();
    expect(r.click({ kind: "face", faceId: 14 })).toBe("taken");
    expect(treePickWaiting()).toBe(false);
    expect(r.planePick()).toBe(false);
    flushFrame();
    expect(r.deps.sketch.enter).toHaveBeenCalledExactlyOnceWith(slanted, r.deps.store, undefined, undefined, anchor);
    expect(r.showSketchFace).toHaveBeenCalledExactlyOnceWith(14);
  });

  it("Sketch refuses a curved face in words that name a flat face, not the view, and keeps waiting", () => {
    const r = lidRig();
    r.starters.startSketch();
    expect(r.click({ kind: "face", faceId: 15 })).toBe("refused");
    expect(r.hints).toHaveLength(1);
    expect(r.hints[0]).toMatch(/curved/);
    expect(r.hints[0]).toMatch(/flat face or a plane/);
    expect(r.hints[0]).not.toMatch(/in the view/);
    expect(treePickWaiting()).toBe(true);
    flushFrame();
    expect(r.deps.sketch.enter).not.toHaveBeenCalled();
    expect(r.click({ kind: "face", faceId: 14 })).toBe("taken");
  });

  it("Datum Axis on an edge takes an edge row with its body, and refuses a face row", () => {
    const r = lidRig();
    r.starters.createDatumAxisOnEdge();
    expect(r.click({ kind: "face", faceId: 14 })).toBe("refused");
    expect(r.hints).toHaveLength(1);
    expect(r.hints[0]).toMatch(/face.*edge/);
    const points: Vec3[] = [
      [3.5, -2, 5],
      [13.5, 4, 9],
    ];
    expect(r.click(edgeRow(points))).toBe("taken");
    expect(treePickWaiting()).toBe(false);
    flushFrame();
    const line = axisFromEdge(points)!;
    expect(r.addFeature).toHaveBeenCalledExactlyOnceWith({
      id: "f9",
      type: "datumAxis",
      origin: line.origin,
      dir: line.dir,
      axisEdge: { kind: "edge", by: "nearest", point: [8.5, 1, 7], body: "b2" },
      name: "Axis",
    });
  });

  it("Joint takes a face row for each side, and refuses an edge row", () => {
    const r = lidRig();
    r.starters.startJoint();
    expect(
      r.click(
        edgeRow([
          [1, 2, 3],
          [4, 6, 3],
        ]),
      ),
    ).toBe("refused");
    expect(r.click({ kind: "face", faceId: 12 })).toBe("taken");
    flushFrame();
    expect(treePickWaiting()).toBe(true);
    expect(r.click({ kind: "face", faceId: 23 })).toBe("taken");
    flushFrame();
    expect(r.addFeature).toHaveBeenCalledExactlyOnceWith({
      id: "f9",
      type: "joint",
      moving: "b2",
      mate: { body: "b2", face: faceSel(12) },
      to: { body: "b3", face: faceSel(23) },
      mode: "rigid",
    });
  });

  describe("a mechanism joint's two sides", () => {
    const settle = () => new Promise<void>((r) => setTimeout(r, 0));
    const ownerOf = (id: number) => (id === 99 ? null : id > 20 ? "b3" : "b2");
    const slantedEdge = (body: string, points: Vec3[]) =>
      ({
        kind: "edge",
        edge: { id: `${body}:4`, body, points, smooth: false, slot: 4 } as unknown as EdgeRef,
      }) as const;
    const edgeOnB3: Vec3[] = [
      [3, -4, 7.5],
      [9, -1, 12],
    ];

    async function atSideOne(mode: string = "revolute") {
      const r = lidRig();
      Object.assign(r.viewport, { faceIdToBodyId: ownerOf, hoverEntity: () => {} });
      answers.queue = [mode, "done", ""];
      const done = r.starters.startMechanism();
      expect(r.click({ kind: "body", id: "b3" })).toBe("taken");
      flushFrame();
      await settle();
      return { r, done };
    }

    it("takes side one from a round face row and side two from a slanted edge row", async () => {
      const { r, done } = await atSideOne();
      expect(treePickWaiting()).toBe(true);
      expect(r.click({ kind: "face", faceId: 15 })).toBe("taken");
      expect(treePickWaiting()).toBe(false);
      flushFrame();
      await settle();
      expect(treePickWaiting()).toBe(true);
      expect(r.click(slantedEdge("b3", edgeOnB3))).toBe("taken");
      flushFrame();
      await done;
      expect(r.addFeature).toHaveBeenCalledExactlyOnceWith({
        id: "f9",
        type: "mechanism",
        ground: "b3",
        joints: [
          {
            id: "pin1",
            mode: "revolute",
            a: { body: "b2", axis: faceSel(15) },
            b: { body: "b3", axis: { kind: "edge", by: "nearest", point: [6, -2.5, 9.75], body: "b3" } },
          },
        ],
      });
    });

    it("refuses a face and an edge on the part already picked, and keeps waiting for the other part", async () => {
      const { r, done } = await atSideOne("slider");
      r.click({ kind: "face", faceId: 14 });
      flushFrame();
      await settle();
      const onB2 = slantedEdge("b2", [
        [1, 2, 3],
        [4, 6, 3],
      ]);
      for (const row of [{ kind: "face", faceId: 12 } as const, onB2]) {
        r.hints.length = 0;
        expect(r.click(row)).toBe("refused");
        expect(r.hints).toHaveLength(1);
        expect(r.hints[0]).toMatch(/already picked/);
        expect(r.hints[0]).toMatch(/other part/);
        expect(treePickWaiting()).toBe(true);
      }
      flushFrame();
      expect(r.addFeature).not.toHaveBeenCalled();
      expect(r.click({ kind: "face", faceId: 23 })).toBe("taken");
      flushFrame();
      await done;
      const joint = (r.addFeature.mock.calls[0]![0] as { joints: { b: unknown }[] }).joints[0]!;
      expect(joint.b).toEqual({ body: "b3", axis: faceSel(23) });
    });

    it("refuses a face that belongs to no body and a row that is neither a face nor an edge", async () => {
      const { r } = await atSideOne();
      expect(r.click({ kind: "face", faceId: 99 })).toBe("refused");
      expect(r.hints.at(-1)).toMatch(/no part/);
      expect(r.click({ kind: "datumPoint", id: "dp", point: [1, 2, 3] })).toBe("refused");
      expect(r.hints.at(-1)).toMatch(/datum point/);
      expect(r.hints.at(-1)).toMatch(/face or an edge/);
      expect(r.hints.at(-1)).not.toMatch(/in the view/);
      expect(r.click(slantedEdge("", edgeOnB3))).toBe("refused");
      expect(treePickWaiting()).toBe(true);
      flushFrame();
      expect(r.addFeature).not.toHaveBeenCalled();
    });

    it("takes a row on either body for side one, a second document leaks nothing", async () => {
      const first = await atSideOne();
      expect(first.r.click({ kind: "face", faceId: 23 })).toBe("taken");
      flushFrame();
      await settle();
      expect(first.r.click({ kind: "face", faceId: 12 })).toBe("taken");
      flushFrame();
      await first.done;
      const second = await atSideOne("rigid");
      expect(second.r.click({ kind: "face", faceId: 12 })).toBe("taken");
      flushFrame();
      await settle();
      expect(second.r.click({ kind: "face", faceId: 12 })).toBe("refused");
      expect(second.r.click({ kind: "face", faceId: 23 })).toBe("taken");
      flushFrame();
      await second.done;
      const joints = (second.r.addFeature.mock.calls[0]![0] as { joints: unknown[] }).joints;
      expect(joints).toEqual([
        { id: "weld1", mode: "rigid", a: { body: "b2", axis: faceSel(12) }, b: { body: "b3", axis: faceSel(23) } },
      ]);
    });
  });
  describe("Revolve's axis", () => {
    const a: Vec3 = [2, 3, 4];
    const b: Vec3 = [32, 3, 44];
    const revolveRig = () => {
      const r = lidRig();
      Object.assign(r.viewport, { scene: { triad: { arms: [], highlight: vi.fn() } } });
      Object.assign(r.deps.overlay, { regions: [{ sketchId: "s1", interior3D: { x: 1, y: 2, z: 3 } }] });
      r.starters.startRevolve();
      return r;
    };
    // The middle point is `off` away from the chord, sideways, so only the line's tolerance decides.
    const bent = (off: number): Vec3[] => [a, [17, 3 + off, 24], b];

    it("takes a slanted straight edge row with its body, as the click would", () => {
      const r = revolveRig();
      expect(r.click(edgeRow([a, b]))).toBe("taken");
      expect(treePickWaiting()).toBe(false);
      expect(r.planePick()).toBe(false);
      flushFrame();
      expect(r.addFeature).toHaveBeenCalledExactlyOnceWith({
        id: "f9",
        type: "revolve",
        sketch: "s1",
        axis: axisFromEdge([a, b])!,
        angle: 360,
        operation: "new",
        regions: [[1, 2, 3]],
        axisEdge: { kind: "edge", by: "nearest", point: [17, 3, 24], body: "b2" },
      });
    });

    it("refuses a face row and a curved edge row, and keeps waiting for a straight one", () => {
      const r = revolveRig();
      expect(r.click({ kind: "face", faceId: 14 })).toBe("refused");
      expect(r.hints[0]).toMatch(/axis/);
      expect(r.click(edgeRow(bent(2.5)))).toBe("refused");
      expect(r.hints).toHaveLength(2);
      expect(r.hints[1]).toMatch(/straight/);
      expect(treePickWaiting()).toBe(true);
      flushFrame();
      expect(r.addFeature).not.toHaveBeenCalled();
      expect(r.click(edgeRow([a, b]))).toBe("taken");
    });

    it("takes a row that bends less than the tolerance and refuses one that bends more", () => {
      const r = revolveRig();
      expect(r.click(edgeRow(bent(0.006)))).toBe("refused");
      expect(r.click(edgeRow(bent(0.004)))).toBe("taken");
    });

    it("a second revolve after the first starts clean and takes another edge", () => {
      const r = revolveRig();
      r.click(edgeRow([a, b]));
      flushFrame();
      expect(treePickWaiting()).toBe(false);
      r.starters.startRevolve();
      const c: Vec3[] = [
        [-5, 8, 1],
        [-5, 18, 1],
      ];
      expect(r.click(edgeRow(c))).toBe("taken");
      flushFrame();
      expect(r.addFeature).toHaveBeenCalledTimes(2);
      const second = r.addFeature.mock.calls[1]![0] as { axis: unknown; axisEdge: unknown };
      expect(second.axis).toEqual(axisFromEdge(c));
      expect(second.axisEdge).toEqual({ kind: "edge", by: "nearest", point: [-5, 13, 1], body: "b2" });
    });
  });
  describe("Axis from cylinder", () => {
    const roundRig = () => {
      const r = lidRig();
      const parts = faceRowViewport().parts;
      const cylinderOf = (id: number) => {
        const tris = parts.faceTriangles(id);
        const pts: Vec3[] = [];
        const normals: Vec3[] = [];
        for (const t of tris) {
          pts.push(asVec(t.a), asVec(t.b), asVec(t.c));
          normals.push(asVec(t.getNormal(new THREE.Vector3())));
        }
        return cylinderFromFace(pts, normals);
      };
      Object.assign(r.viewport, parts, { faceCylinder: cylinderOf });
      r.starters.createAxisFromCylinder();
      return { ...r, cylinderOf };
    };

    it("takes a round face row and adds the axis the click would, through that face", () => {
      const r = roundRig();
      expect(r.click({ kind: "face", faceId: 15 })).toBe("taken");
      expect(treePickWaiting()).toBe(false);
      expect(r.planePick()).toBe(false);
      flushFrame();
      const cyl = r.cylinderOf(15)!;
      expect(cyl.radius).toBeCloseTo(4, 6);
      expect(Math.abs(cyl.axis[1])).toBeCloseTo(0.6, 6);
      expect(r.addFeature).toHaveBeenCalledExactlyOnceWith({
        id: "f9",
        type: "datumAxis",
        origin: cyl.point,
        dir: cyl.axis,
        name: "Axis",
        through: { kind: "cylinder", face: { kind: "face", by: "nearest", point: asVec(CYL_ANCHOR), body: "b2" } },
      });
    });

    it("refuses a flat face, a sphere, an unknown face and a plane row, and keeps waiting", () => {
      const r = roundRig();
      expect(r.click({ kind: "face", faceId: 14 })).toBe("refused");
      expect(r.hints[0]).toMatch(/flat/);
      expect(r.hints[0]).toMatch(/round face/);
      expect(r.click({ kind: "face", faceId: 16 })).toBe("refused");
      expect(r.hints[1]).toMatch(/not round/);
      expect(r.click({ kind: "face", faceId: 99 })).toBe("refused");
      expect(r.click({ kind: "basePlane", plane: "XZ" })).toBe("refused");
      expect(r.hints).toHaveLength(4);
      expect(r.hints[3]).toMatch(/round face/);
      expect(treePickWaiting()).toBe(true);
      flushFrame();
      expect(r.addFeature).not.toHaveBeenCalled();
      expect(r.click({ kind: "face", faceId: 15 })).toBe("taken");
    });

    it("a second pick after the first starts clean, and a flat face row still goes to Sketch", () => {
      const r = roundRig();
      r.click({ kind: "face", faceId: 15 });
      flushFrame();
      expect(treePickWaiting()).toBe(false);
      r.starters.startSketch();
      expect(r.click({ kind: "face", faceId: 14 })).toBe("taken");
      flushFrame();
      expect(r.deps.sketch.enter).toHaveBeenCalledTimes(1);
      expect(r.addFeature).toHaveBeenCalledTimes(1);
    });
  });
});
