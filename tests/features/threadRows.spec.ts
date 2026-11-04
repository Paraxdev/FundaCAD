// A Geometry list row reaches Thread while it waits for a face, as that round face selected before the start.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { ThreadTool } from "../../src/features/threadTool";
import { resetTreePicks, routeTreeClick, treePickWaiting } from "../../src/ui/treePick";
import type { DocumentStore, RebuildState } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { PressPullFaces } from "../../src/viewport/faceAnalysis";
import type { Feature } from "../../src/types";

const BORE = 5;
const SHANK = 6;
const FLAT = 8;
const HOLLOW = 13;

const axisOf = new THREE.Vector3(0, 0.6, 0.8);
const base = new THREE.Vector3(20, -5, 10);
const radiusOf = (id: number) => (id === SHANK ? 3.5 : 4);

function facesOf(ids: readonly number[]): PressPullFaces {
  const id = ids[0]!;
  const round =
    id === FLAT
      ? null
      : {
          radius: radiusOf(id),
          solidInside: id === SHANK,
          cylinder: { axis: axisOf.toArray(), point: base.toArray(), radius: radiusOf(id) },
          radial: new THREE.Vector3(1, 0, 0),
          full: true,
          tangent: null,
        };
  return {
    selectors: ids.map((i) => ({ kind: "face", by: "nearest", point: [i, 2, 3] })),
    faceIds: [...ids],
    normal: new THREE.Vector3(1, 0, 0),
    anchor: new THREE.Vector3(id, 2.5, 3.5),
    bodyId: id === SHANK ? "b3" : "b2",
    round,
    lead: null,
  } as unknown as PressPullFaces;
}

function rig(selected: number[], building = false) {
  const along = (lo: number, hi: number) => [
    {
      a: base.clone().addScaledVector(axisOf, lo),
      b: base.clone().addScaledVector(axisOf, hi),
      c: base.clone().add(new THREE.Vector3(1, 0, 0)),
    },
  ];
  const vp = {
    suspendPicking: false,
    domElement: document.createElement("canvas"),
    camera: new THREE.PerspectiveCamera(),
    addToScene: () => {},
    removeFromScene: () => {},
    requestRender: () => {},
    pixelWorldSize: () => 0.1,
    modelDiagonal: () => 100,
    projectToScreen: () => ({ x: 0, y: 0 }),
    snapStep: () => 0.05,
    clearHover: () => {},
    hoverFaceAt: () => null,
    pickFaceForPressPull: () => null,
    selectedFacesForPressPull: () => (selected.length ? facesOf(selected) : null),
    facesForPressPull: (ids: readonly number[]) => (building ? null : facesOf(ids)),
    faceTriangles: (id: number) => (id === HOLLOW ? [] : along(-2, id === SHANK ? 11.5 : 14)),
  };
  const store = {
    nextId: () => "t1",
    boundExpr: () => null,
    setPreview: () => {},
    addFeature: (_f: Feature) => {},
    verifyCommit: () => {},
    onBuild: () => () => {},
    faceAxis: async () => null,
    hasPreview: false,
    previewError: null,
    buildState: { building: false } as RebuildState,
    document: { parameters: {}, features: [] },
    isParamBound: () => false,
  };
  return { vp: vp as unknown as Viewport, store: store as unknown as DocumentStore };
}

interface Internals {
  phase: string;
  axis: THREE.Vector3;
  origin: THREE.Vector3;
  radial: THREE.Vector3;
  radius: number;
  face: unknown;
  external: boolean;
  pitch: number;
  length: number;
  maxLength: number;
}

const seen = (t: unknown) => {
  const i = t as Internals;
  return {
    phase: i.phase,
    axis: i.axis.toArray(),
    origin: i.origin.toArray(),
    radial: i.radial.toArray(),
    radius: i.radius,
    face: i.face,
    external: i.external,
    pitch: i.pitch,
    length: i.length,
    maxLength: i.maxLength,
  };
};

function start(selected: number[], building = false) {
  const r = rig(selected, building);
  const done = vi.fn();
  const tool = new ThreadTool(r.vp, r.store);
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

describe("Thread takes a face row while it waits", () => {
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

  it.each([BORE, SHANK])("sizes along a slanted round face %i as that face selected before the start", (id) => {
    const before = start([id]);
    const want = seen(before.tool);
    before.tool.cancel();
    resetTreePicks();

    const waiting = start([]);
    expect(seen(waiting.tool).phase).toBe("pick");
    expect(treePickWaiting()).toBe(true);
    const d = hints();
    expect(routeTreeClick({ kind: "face", faceId: id }, d)).toBe("taken");
    expect(seen(waiting.tool)).toEqual(want);
    expect(want).toMatchObject({
      phase: "size",
      axis: axisOf.toArray(),
      radius: radiusOf(id),
      external: id === SHANK,
      face: { kind: "face", by: "nearest", point: [id, 2, 3], body: id === SHANK ? "b3" : "b2" },
    });
    expect(want.maxLength).toBeCloseTo(id === SHANK ? 13.5 : 16, 9);
    expect([d.said, treePickWaiting()]).toEqual([[], false]);
    waiting.tool.cancel();
  });

  it("refuses a flat face row in words and keeps waiting", () => {
    const { tool, done } = start([]);
    const d = hints();
    expect(routeTreeClick({ kind: "face", faceId: FLAT }, d)).toBe("refused");
    expect([d.said.length, seen(tool).phase, treePickWaiting(), done.mock.calls]).toEqual([1, "pick", true, []]);
    expect(d.said[0]).toMatch(/not round/);
    expect(routeTreeClick({ kind: "face", faceId: BORE }, hints())).toBe("taken");
    expect(seen(tool).phase).toBe("size");
    tool.cancel();
  });

  it("refuses an edge row in words and keeps waiting", () => {
    const { tool, done } = start([]);
    const d = hints();
    expect(routeTreeClick(edgeRow, d)).toBe("refused");
    expect([d.said, seen(tool).phase, treePickWaiting(), done.mock.calls]).toEqual([
      ["That row is an edge, this step needs a round face"],
      "pick",
      true,
      [],
    ]);
    tool.cancel();
  });

  it("says the model is still building and keeps waiting", () => {
    const building = start([], true);
    const d = hints();
    expect(routeTreeClick({ kind: "face", faceId: BORE }, d)).toBe("refused");
    expect([d.said, seen(building.tool).phase, treePickWaiting()]).toEqual([
      ["The model is still building"],
      "pick",
      true,
    ]);
    building.tool.cancel();
  });

  it("a flat face selected before the start still waits and a later round row is taken", () => {
    const { tool } = start([FLAT]);
    expect([seen(tool).phase, treePickWaiting()]).toEqual(["pick", true]);
    routeTreeClick({ kind: "face", faceId: BORE }, hints());
    expect(seen(tool).phase).toBe("size");
    tool.cancel();
  });

  it("a face with no length ends the tool and leaves no session", () => {
    const { tool, done } = start([]);
    expect(routeTreeClick({ kind: "face", faceId: HOLLOW }, hints())).toBe("taken");
    expect([seen(tool).phase, treePickWaiting(), done.mock.calls]).toEqual(["pick", false, [[null]]]);
  });

  it("a cancel leaves no session, and a second tool takes its own rows", () => {
    const first = start([]);
    first.tool.cancel();
    expect([treePickWaiting(), first.done.mock.calls]).toEqual([false, [[null]]]);
    const second = start([]);
    expect(treePickWaiting()).toBe(true);
    routeTreeClick({ kind: "face", faceId: SHANK }, hints());
    expect(seen(second.tool)).toMatchObject({ phase: "size", external: true, radius: 3.5 });
    expect(seen(first.tool).phase).toBe("pick");
    second.tool.cancel();
    expect(treePickWaiting()).toBe(false);
  });
});
