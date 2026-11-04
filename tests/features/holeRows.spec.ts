// A Geometry list row reaches Hole while it waits for a face, as that flat face selected before the start.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { HoleTool } from "../../src/features/holeTool";
import { resetTreePicks, routeTreeClick, treePickWaiting } from "../../src/ui/treePick";
import { classifyExprInput } from "../../src/params/engine";
import type { DocumentStore, RebuildState } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { PressPullFaces } from "../../src/viewport/faceAnalysis";
import type { Feature, Vec3 } from "../../src/types";

const SLANT = 7;
const OTHER = 9;
const ROUND = 11;
const centre = (id: number) => new THREE.Vector3(id + 12.5, -7.25 - id, 30 + id / 2);
const slanted = new THREE.Vector3(0, 0.6, 0.8);

function facesOf(ids: readonly number[]): PressPullFaces {
  return {
    selectors: ids.map((id) => ({ kind: "face", by: "nearest", point: [id, 2, 3] })),
    faceIds: [...ids],
    normal: slanted.clone(),
    anchor: new THREE.Vector3(ids[0]! + 1, 2.5, 3.5),
    bodyId: ids[0] === OTHER ? "b3" : "b2",
    round: null,
    lead: null,
  } as PressPullFaces;
}

function rig(selected: number[], building = false) {
  const vp = {
    suspendPicking: false,
    domElement: document.createElement("canvas"),
    addToScene: () => {},
    removeFromScene: () => {},
    requestRender: () => {},
    pixelWorldSize: () => 0.1,
    projectToScreen: () => ({ x: 0, y: 0 }),
    clearHover: () => {},
    hoverFaceAt: () => null,
    pickFaceForPressPull: () => null,
    selectedFacesForPressPull: () => (selected.length ? facesOf(selected) : null),
    facesForPressPull: (ids: readonly number[]) => (building ? null : facesOf(ids)),
    planarFace: (id: number) =>
      id === ROUND ? null : { faceId: id, normal: slanted.clone(), origin: new THREE.Vector3(12.5, -7.25, 30 + id) },
    faceAreaCentroidWorld: (id: number) => centre(id),
    modelBox: () => new THREE.Box3(new THREE.Vector3(-10, -10, 0), new THREE.Vector3(10, 10, 10)),
  };
  const added: Feature[] = [];
  const store = {
    nextId: () => "h1",
    boundExpr: () => null,
    classifyTargetExpr: (...a: Parameters<typeof classifyExprInput> extends [unknown, ...infer R] ? R : never) =>
      classifyExprInput({ parameters: {}, features: [] }, ...a),
    setPreview: () => {},
    addFeature: (f: Feature) => added.push(f),
    verifyCommit: () => {},
    onBuild: () => () => {},
    hasPreview: false,
    previewError: null,
    buildState: { building: false } as RebuildState,
    document: { parameters: {}, features: [] },
    isParamBound: () => false,
  };
  return { vp: vp as unknown as Viewport, store: store as unknown as DocumentStore, added };
}

interface Internals {
  phase: string;
  normal: THREE.Vector3;
  origin: THREE.Vector3;
  center: THREE.Vector3;
  bodyId: string | null;
  points: Vec3[];
  face: unknown;
}

const seen = (t: unknown) => {
  const i = t as Internals;
  return {
    phase: i.phase,
    normal: i.normal.toArray(),
    origin: i.origin.toArray(),
    center: i.center.toArray(),
    bodyId: i.bodyId,
    points: i.points,
    face: i.face,
  };
};

function start(selected: number[], building = false) {
  const r = rig(selected, building);
  const done = vi.fn();
  const tool = new HoleTool(r.vp, r.store);
  tool.start(done);
  return { tool, done };
}

const hints = () => {
  const said: string[] = [];
  return { said, busyHint: () => null, hint: (t: string) => said.push(t) };
};

const edgeRow = {
  kind: "edge",
  edge: {
    body: "b2",
    points: [
      [1, 2, 3],
      [4, 5, 6],
    ],
  },
} as never;

describe("Hole takes a face row while it waits", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    resetTreePicks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("places on a slanted flat face as that face selected before the start, and the session ends", () => {
    const before = start([SLANT]);
    const want = seen(before.tool);
    before.tool.cancel();
    resetTreePicks();

    const waiting = start([]);
    expect(seen(waiting.tool).phase).toBe("pick");
    expect(treePickWaiting()).toBe(true);
    const d = hints();
    expect(routeTreeClick({ kind: "face", faceId: SLANT }, d)).toBe("taken");
    expect(seen(waiting.tool)).toEqual(want);
    expect(want).toMatchObject({
      phase: "place",
      normal: [0, 0.6, 0.8],
      center: centre(SLANT).toArray(),
      bodyId: "b2",
    });
    expect([d.said, treePickWaiting()]).toEqual([[], false]);
    waiting.tool.cancel();
  });

  it("takes the body and plane of the row's own face", () => {
    const { tool } = start([]);
    routeTreeClick({ kind: "face", faceId: OTHER }, hints());
    expect(seen(tool)).toMatchObject({
      bodyId: "b3",
      origin: [12.5, -7.25, 30 + OTHER],
      center: centre(OTHER).toArray(),
    });
    tool.cancel();
  });

  it("refuses a curved face row in words and keeps waiting", () => {
    const { tool, done } = start([]);
    const d = hints();
    expect(routeTreeClick({ kind: "face", faceId: ROUND }, d)).toBe("refused");
    expect([d.said.length, seen(tool).phase, treePickWaiting(), done.mock.calls]).toEqual([1, "pick", true, []]);
    expect(d.said[0]).toMatch(/curved/);
    expect(routeTreeClick({ kind: "face", faceId: SLANT }, hints())).toBe("taken");
    expect(seen(tool).phase).toBe("place");
    tool.cancel();
  });

  it("refuses an edge row in words and keeps waiting", () => {
    const { tool, done } = start([]);
    const d = hints();
    expect(routeTreeClick(edgeRow, d)).toBe("refused");
    expect([d.said, seen(tool).phase, treePickWaiting(), done.mock.calls]).toEqual([
      ["That row is an edge, this step needs a flat face"],
      "pick",
      true,
      [],
    ]);
    tool.cancel();
  });

  it("says the model is still building and keeps waiting", () => {
    const building = start([], true);
    const d = hints();
    expect(routeTreeClick({ kind: "face", faceId: SLANT }, d)).toBe("refused");
    expect([d.said, seen(building.tool).phase, treePickWaiting()]).toEqual([
      ["The model is still building"],
      "pick",
      true,
    ]);
    building.tool.cancel();
  });

  it("a curved face selected before the start still waits and a later flat row is taken", () => {
    const { tool } = start([ROUND]);
    expect([seen(tool).phase, treePickWaiting()]).toEqual(["pick", true]);
    routeTreeClick({ kind: "face", faceId: SLANT }, hints());
    expect(seen(tool).phase).toBe("place");
    tool.cancel();
  });

  it("a cancel leaves no session, and a second tool takes its own rows", () => {
    const first = start([]);
    first.tool.cancel();
    expect([treePickWaiting(), first.done.mock.calls]).toEqual([false, [[null]]]);
    const second = start([]);
    expect(treePickWaiting()).toBe(true);
    routeTreeClick({ kind: "face", faceId: OTHER }, hints());
    expect(seen(second.tool)).toMatchObject({ phase: "place", bodyId: "b3" });
    expect(seen(first.tool).phase).toBe("pick");
    second.tool.cancel();
    expect(treePickWaiting()).toBe(false);
  });
});
