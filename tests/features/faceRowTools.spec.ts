// A Geometry list row reaches Draft while it waits for a face, as that face selected first.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { DraftTool } from "../../src/features/draftTool";
import { resetTreePicks, routeTreeClick, treePickWaiting } from "../../src/ui/treePick";
import type { DocumentStore, RebuildState } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { PressPullFaces } from "../../src/viewport/faceAnalysis";
import type { Feature, Selector, Vec3 } from "../../src/types";
import type { RoundFace } from "../../src/features/radialDrag";

const SLANT = 7;
const OTHER = 9;
const ROUND = 11;
const point = (id: number): Vec3 => [id * 1.5 + 2, -2.25 - id, 7.5 + id / 2];
const face = (id: number): Selector => ({ kind: "face", by: "nearest", point: point(id) });

const bore: RoundFace = {
  cylinder: { axis: [0, 0, 1], point: [3, -5.5, 0], radius: 2.5 },
  radius: 2.5,
  solidInside: false,
  radial: new THREE.Vector3(1, 0, 0),
  full: true,
  tangent: null,
};

function facesOf(ids: readonly number[]): PressPullFaces {
  const round = ids[0] === ROUND ? bore : null;
  return {
    selectors: ids.map(face),
    faceIds: [...ids],
    normal: round ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0.6, 0.8),
    anchor: new THREE.Vector3(...point(ids[0]!)),
    bodyId: ids[0] === OTHER ? "b3" : "b2",
    round,
    lead: null,
  };
}

function rig(selected: number[], building = false) {
  const scene = new THREE.Scene();
  const vp = {
    suspendPicking: false,
    domElement: document.createElement("canvas"),
    camera: new THREE.PerspectiveCamera(),
    addToScene: (o: THREE.Object3D) => scene.add(o),
    removeFromScene: (o: THREE.Object3D) => scene.remove(o),
    requestRender: () => {},
    pixelWorldSize: () => 0.1,
    modelDiagonal: () => 100,
    projectToScreen: (p: THREE.Vector3) => ({ x: p.x * 10, y: p.y * 10 }),
    probe: () => null,
    snapStep: () => 0.05,
    clearHover: () => {},
    hoverFaceAt: () => null,
    pickFaceForPressPull: () => null,
    selectedFacesForPressPull: () => (selected.length ? facesOf(selected) : null),
    facesForPressPull: (ids: readonly number[]) => (building ? null : facesOf(ids)),
    roundFaceAt: (id: number) => (id === ROUND ? bore : null),
    thicknessBehind: () => null,
    faceTriangles: () => [],
    faceIdNear: () => null,
    faceIdToBodyId: (id: number) => (id === OTHER ? "b3" : "b2"),
  };
  const store = {
    nextId: () => "p1",
    boundExpr: () => null,
    setPreview: () => {},
    addFeature: (_f: Feature) => {},
    verifyCommit: () => {},
    onBuild: (_fn: (s: RebuildState) => void) => () => {},
    faceAxis: async () => null,
    hasPreview: false,
    previewError: null,
    buildState: { building: false },
  };
  return { vp: vp as unknown as Viewport, store: store as unknown as DocumentStore };
}

interface Internals {
  phase: string;
  faces: Selector[];
  faceIds: number[];
  bodyId: string | null;
  anchor: THREE.Vector3;
  axis?: THREE.Vector3;
  faceNormal?: THREE.Vector3;
  round?: RoundFace | null;
}

interface Rows {
  name: string;
  sign: 1 | -1;
  start: (selected: number[], building?: boolean) => { tool: { cancel(): void }; done: ReturnType<typeof vi.fn> };
}

const drafting: Rows = {
  name: "Draft",
  sign: 1,
  start(selected, building) {
    const { vp, store } = rig(selected, building);
    const done = vi.fn();
    const tool = new DraftTool(vp, store);
    tool.start(done);
    return { tool, done };
  },
};

const seen = (t: unknown) => {
  const i = t as Internals;
  return {
    phase: i.phase,
    faces: i.faces,
    faceIds: i.faceIds,
    bodyId: i.bodyId,
    anchor: i.anchor.toArray(),
    along: (i.axis ?? i.faceNormal)!.toArray(),
    round: i.round ?? null,
  };
};

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

function stubFrames() {
  setActivePinia(createPinia());
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
}

function tidy() {
  resetTreePicks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
}

describe.each([drafting])("$name takes a face row while it waits", (tool) => {
  beforeEach(stubFrames);
  afterEach(tidy);

  it("starts the drag as that slanted face selected before the start, and the session ends", () => {
    const before = tool.start([SLANT]);
    const want = seen(before.tool);
    before.tool.cancel();
    resetTreePicks();

    const waiting = tool.start([]);
    expect(seen(waiting.tool).phase).toBe("pick");
    expect(treePickWaiting()).toBe(true);
    const d = hints();
    expect(routeTreeClick({ kind: "face", faceId: SLANT }, d)).toBe("taken");
    expect(seen(waiting.tool)).toEqual(want);
    expect(want).toMatchObject({
      phase: "drag",
      faceIds: [SLANT],
      anchor: point(SLANT),
      along: tool.sign === 1 ? [0, 0.6, 0.8] : [-0, -0.6, -0.8],
    });
    expect([d.said, treePickWaiting()]).toEqual([[], false]);
    waiting.tool.cancel();
  });

  it("takes the body the row's face is on", () => {
    const { tool: t } = tool.start([]);
    routeTreeClick({ kind: "face", faceId: OTHER }, hints());
    expect(seen(t)).toMatchObject({ faceIds: [OTHER], bodyId: "b3", anchor: point(OTHER) });
    t.cancel();
  });

  it("refuses an edge row in words and keeps waiting", () => {
    const { tool: t, done } = tool.start([]);
    const d = hints();
    expect(routeTreeClick(edgeRow, d)).toBe("refused");
    expect([d.said, seen(t).phase, treePickWaiting(), done.mock.calls]).toEqual([
      ["That row is an edge, this step needs a face"],
      "pick",
      true,
      [],
    ]);
    t.cancel();
  });

  it("says the model is still building and keeps waiting", () => {
    const building = tool.start([], true);
    const d = hints();
    expect(routeTreeClick({ kind: "face", faceId: SLANT }, d)).toBe("refused");
    expect([d.said, seen(building.tool).phase, treePickWaiting()]).toEqual([
      ["The model is still building"],
      "pick",
      true,
    ]);
    building.tool.cancel();
  });

  it("a cancel from outside leaves no session, and a second document's tool takes its own rows", () => {
    const first = tool.start([]);
    first.tool.cancel();
    expect([treePickWaiting(), first.done.mock.calls]).toEqual([false, [[null]]]);

    const second = tool.start([]);
    expect(routeTreeClick({ kind: "face", faceId: OTHER }, hints())).toBe("taken");
    expect([seen(first.tool).phase, seen(second.tool).faceIds]).toEqual(["pick", [OTHER]]);
    second.tool.cancel();
  });

  it("a tool started with a face already selected waits for no row", () => {
    const { tool: t } = tool.start([SLANT]);
    expect(treePickWaiting()).toBe(false);
    t.cancel();
  });
});
