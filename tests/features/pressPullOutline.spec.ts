// While Press/Pull is open a rigid push of flat faces draws the outline of the volume it adds or takes away over the
// opaque body: a ring at the face and one at its new place, a line up every corner, the accent for an add and the error
// colour for a cut. A round or tapered push keeps the engine's preview alone.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { PressPullTool } from "../../src/features/pressPullTool";
import { edgeSelectColor } from "../../src/viewport/highlight";
import { themeColor } from "../../src/viewport/themeColors";
import type { DocumentStore, RebuildState } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { PressPullFaces } from "../../src/viewport/faceAnalysis";
import type { Feature, Selector, Vec3 } from "../../src/types";
import type { RoundFace } from "../../src/features/radialDrag";

type P = [number, number, number];

// Flat faces on one slanted plane (normal (0, 0.6, 0.8), u = +X, v = (0, 0.8, -0.6)), each a rectangle off the origin.
const NORMAL = new THREE.Vector3(0, 0.6, 0.8);
const V = new THREE.Vector3(0, 0.8, -0.6);
const ROUND = 11;
const rects: Record<number, { at: P; w: number; h: number }> = {
  10: { at: [3, -2.5, 7.5], w: 6, h: 3 },
  11: { at: [1, 1, 1], w: 1, h: 1 },
  12: { at: [-4, 1.5, 2], w: 2.5, h: 7 },
  13: { at: [9, 0.25, 5], w: 4, h: 4 },
  14: { at: [-7, -3.5, 4.5], w: 3, h: 2 },
};
// A flat face on the same body that does not face the way the others do
const ASKEW = 14;
const ASKEW_NORMAL = new THREE.Vector3(0.8, 0, 0.6);
const corner = (id: number, a: number, b: number, along = 0): P => {
  const r = rects[id]!;
  const p = new THREE.Vector3(...r.at)
    .addScaledVector(new THREE.Vector3(1, 0, 0), a * r.w)
    .addScaledVector(V, b * r.h)
    .addScaledVector(NORMAL, along);
  return [p.x, p.y, p.z];
};
const loop = (id: number, along = 0): P[] =>
  [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ].map(([a, b]) => corner(id, a!, b!, along));
const point = (id: number): Vec3 => corner(id, 0.5, 0.5);

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
    selectors: ids.map((id): Selector => ({ kind: "face", by: "nearest", point: point(id) })),
    faceIds: [...ids],
    normal: round ? new THREE.Vector3(1, 0, 0) : NORMAL.clone(),
    anchor: new THREE.Vector3(...point(ids[0]!)),
    bodyId: "b2",
    round,
    lead: null,
  };
}

const round4 = (p: ArrayLike<number>): P => [0, 1, 2].map((i) => Math.round(p[i]! * 1e4) / 1e4) as P;
const key = (s: [P, P]) =>
  JSON.stringify([round4(s[0]), round4(s[1])].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]));
const keys = (segs: [P, P][]) => segs.map(key).sort();
const ringSegs = (pts: P[]): [P, P][] => pts.map((p, i) => [p, pts[(i + 1) % pts.length]!]);
const sides = (id: number, along: number) => loop(id).map((p, i) => [p, loop(id, along)[i]!] as [P, P]);
const box = (id: number, along: number): [P, P][] => [
  ...ringSegs(loop(id)),
  ...ringSegs(loop(id, along)),
  ...sides(id, along),
];

interface Internals {
  value: number;
  taper: number;
  mode: string;
  refreshPreview(now?: boolean): void;
}

// The 4 edges of a face in mixed order and direction, as the model lists them
const edgesOf = (ids: readonly number[]) =>
  ids.flatMap((id) => {
    const l = loop(id, moved[id] ?? 0);
    return [2, 0, 3, 1].map((i) => ({ points: i % 2 ? [l[(i + 1) % 4]!, l[i]!] : [l[i]!, l[(i + 1) % 4]!] }));
  });

// How far the viewport's model has each face moved, as it shows a preview that landed
let moved: Record<number, number> = {};
let scene: THREE.Object3D[] = [];
let listeners: ((s: RebuildState) => void)[] = [];
const tools: PressPullTool[] = [];

function rig(selected: number[], edges: (ids: readonly number[]) => unknown[] = edgesOf) {
  scene = [];
  listeners = [];
  moved = {};
  const selectOnlyFaces = vi.fn();
  const stands: { at: P; id: number }[] = [];
  const canvas = document.createElement("canvas");
  const setPeek = vi.fn();
  let hit: object | null = null;
  const vp = {
    suspendPicking: false,
    domElement: canvas,
    camera: new THREE.PerspectiveCamera(),
    addToScene: (o: THREE.Object3D) => void scene.push(o),
    removeFromScene: (o: THREE.Object3D) => {
      scene = scene.filter((x) => x !== o);
    },
    requestRender: () => {},
    pixelWorldSize: () => 0.1,
    projectToScreen: (p: THREE.Vector3) => ({ x: p.x * 10, y: p.y * 10 }),
    snapStep: () => 0.05,
    clearHover: () => {},
    hoverFaceAt: () => null,
    pickFaceForPressPull: () => hit,
    selectedFacesForPressPull: () => facesOf(selected),
    facesForPressPull: (ids: readonly number[]) => facesOf(ids),
    planarFace: (id: number) =>
      id === ROUND
        ? null
        : { normal: (id === ASKEW ? ASKEW_NORMAL : NORMAL).clone(), origin: new THREE.Vector3(...point(id)) },
    roundFaceAt: (id: number) => (id === ROUND ? bore : null),
    edgesOfFaces: edges,
    faceTriangles: (id: number) => {
      const [a, b, c, d] = loop(id, moved[id] ?? 0).map((p) => new THREE.Vector3(...p)) as [
        THREE.Vector3,
        THREE.Vector3,
        THREE.Vector3,
        THREE.Vector3,
      ];
      return [new THREE.Triangle(a, b, c), new THREE.Triangle(a, c, d)];
    },
    faceIdNear: (p: P) => stands.find((n) => n.at.every((x, i) => Math.abs(x - p[i]!) < 1e-3))?.id ?? null,
    selectOnlyFaces,
    faceIdToBodyId: () => "b2",
    clearPressPullGhost: () => {},
    setPressPullGhost: () => {},
    setPeek,
  };
  const added: Feature[] = [];
  const store = {
    nextId: () => "p1",
    setPreview: vi.fn(),
    addFeature: (f: Feature) => added.push(f),
    verifyCommit: () => {},
    boundExpr: () => null,
    isParamBound: () => false,
    onBuild: (_fn: (s: RebuildState) => void) => () => {},
    onSessionBuild: (fn: (s: RebuildState) => void) => {
      listeners.push(fn);
      return () => {
        listeners = listeners.filter((l) => l !== fn);
      };
    },
    faceAxis: async () => ({ reason: "no axis" }),
  };
  const tool = new PressPullTool(vp as unknown as Viewport, store as unknown as DocumentStore);
  tools.push(tool);
  tool.start(vi.fn());
  const t = tool as unknown as Internals;
  const drawn = () => scene.filter((o) => (o as { isLineSegments2?: boolean }).isLineSegments2) as THREE.Mesh[];
  const outline = () => {
    const geo = drawn()[0]?.geometry;
    if (!geo) return null;
    const read = (name: string) => {
      const a = geo.getAttribute(name) as THREE.InterleavedBufferAttribute;
      return Array.from({ length: a.count }, (_, i) => [a.getX(i), a.getY(i), a.getZ(i)] as P);
    };
    const a = read("instanceStart");
    const b = read("instanceEnd");
    return a.map((p, i) => [p, b[i]!] as [P, P]);
  };
  const colour = () => {
    const c = drawn()[0]!.geometry.getAttribute("instanceColorStart") as THREE.InterleavedBufferAttribute;
    return new THREE.Color(c.getX(0), c.getY(0), c.getZ(0)).getHex();
  };
  const push = (value: number) => {
    t.value = value;
    t.refreshPreview(true);
  };
  // A preview building and answering, the way the store reports it
  const land = (distance: number, heldRefusal: unknown = null) => {
    const idle = { building: false, result: {}, errorFeatureId: null, errorMessage: null, progress: null };
    for (const fn of [...listeners]) fn({ ...idle, building: true, result: null } as never);
    const built = { id: "p1", type: "press-pull", distance } as Feature;
    for (const fn of [...listeners]) fn({ ...idle, previewBuilt: [built], heldRefusal } as never);
  };
  const refuse = (distance: number) => land(distance, { featureId: "p1", message: "no" });
  const ctrlAdd = (id: number) => {
    const normal = id === ASKEW ? ASKEW_NORMAL.clone() : NORMAL.clone();
    const anchor = new THREE.Vector3(...point(id));
    hit = { bodyId: "b2", faceId: id, anchor, normal, selector: { kind: "face", by: "nearest", point: point(id) } };
    const down = new MouseEvent("pointerdown", { ctrlKey: true, clientX: 140, clientY: 95 });
    (tool as unknown as { onDown(e: Event): void }).onDown(down);
    hit = null;
  };
  return { tool, t, added, drawn, outline, colour, push, setPeek, selectOnlyFaces, stands, land, refuse, ctrlAdd };
}

const same = (a: number, b: number) => [16, 8, 0].every((s) => Math.abs(((a >> s) & 0xff) - ((b >> s) & 0xff)) <= 2);

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  for (const tool of tools.splice(0)) tool.cancel();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("Press/Pull outline", () => {
  it("draws a ring at the face, one at its new place and a line up each corner", () => {
    const r = rig([10]);
    r.push(5);
    expect(r.drawn()).toHaveLength(2);
    expect(keys(r.outline()!)).toEqual(keys(box(10, 5)));
    expect(same(r.colour(), edgeSelectColor())).toBe(true);
  });

  it("follows the value, 3 mm, 9 mm and back", () => {
    const r = rig([10]);
    for (const v of [3, 9, 4.5]) {
      r.push(v);
      expect(keys(r.outline()!)).toEqual(keys(box(10, v)));
    }
  });

  it("goes into the material in the error colour for a push in", () => {
    const r = rig([10]);
    r.push(-4);
    expect(keys(r.outline()!)).toEqual(keys(box(10, -4)));
    expect(same(r.colour(), themeColor("--error", 0xe23b3b))).toBe(true);
    r.push(2);
    expect(same(r.colour(), edgeSelectColor())).toBe(true);
  });

  it("uses the error colour for Cut mode with the face going out, and the accent for Join going in", () => {
    const r = rig([10]);
    r.t.mode = "cut";
    r.push(3);
    expect(same(r.colour(), themeColor("--error", 0xe23b3b))).toBe(true);
    r.t.mode = "join";
    r.push(-3);
    expect(same(r.colour(), edgeSelectColor())).toBe(true);
  });

  it("draws a ring for every face of a multi face push", () => {
    const r = rig([12, 13]);
    r.push(2.5);
    expect(keys(r.outline()!)).toEqual(keys([...box(12, 2.5), ...box(13, 2.5)]));
  });

  it("adds the ring of a face Ctrl clicked in, facing the same way", () => {
    const r = rig([10]);
    r.ctrlAdd(12);
    r.push(3.5);
    expect(keys(r.outline()!)).toEqual(keys([...box(10, 3.5), ...box(12, 3.5)]));
  });

  it("keeps the first face's ring at its own place when a face is Ctrl clicked in after a preview landed", () => {
    const r = rig([10]);
    r.push(2.5);
    r.land(2.5);
    moved[10] = 2.5;
    r.ctrlAdd(13);
    r.push(2.5);
    expect(keys(r.outline()!)).toEqual(keys([...box(10, 2.5), ...box(13, 2.5)]));
  });

  it("draws nothing once a Ctrl clicked face faces another way, the push is no longer one rigid sweep", () => {
    const r = rig([10]);
    r.push(3.5);
    expect(keys(r.outline()!)).toEqual(keys(box(10, 3.5)));
    r.ctrlAdd(ASKEW);
    r.push(4.25);
    expect(r.drawn()).toHaveLength(0);
  });

  it("draws nothing at zero, and again once the value moves", () => {
    const r = rig([10]);
    r.push(5);
    r.push(0);
    expect(r.drawn()).toHaveLength(0);
    r.push(0.5);
    expect(keys(r.outline()!)).toEqual(keys(box(10, 0.5)));
  });

  it("draws nothing on a round face, where the engine's preview and the guides say it", () => {
    const r = rig([ROUND]);
    r.push(1.5);
    expect(r.drawn()).toHaveLength(0);
  });

  it("draws nothing with an Angle, and again when the Angle goes", () => {
    const r = rig([10]);
    r.push(5);
    r.t.taper = 8;
    r.push(5);
    expect(r.drawn()).toHaveLength(0);
    r.t.taper = 0.04;
    r.push(5);
    expect(r.drawn()).toHaveLength(2);
  });

  it("draws nothing when a face has no closed ring of edges", () => {
    const open = rig([10], (ids) => edgesOf(ids).slice(0, 3));
    open.push(5);
    expect(open.drawn()).toHaveLength(0);
    const none = rig([10], () => []);
    none.push(5);
    expect(none.drawn()).toHaveLength(0);
  });

  it("is gone after a cancel, and the next push shows only its own face", () => {
    const first = rig([10]);
    first.push(5);
    expect(first.drawn()).toHaveLength(2);
    first.tool.cancel();
    expect(first.drawn()).toHaveLength(0);
    const second = rig([12]);
    second.push(3);
    expect(keys(second.outline()!)).toEqual(keys(box(12, 3)));
  });

  it("is gone after a commit", () => {
    const r = rig([10]);
    r.push(5);
    (r.tool as unknown as { commit(): void }).commit();
    expect(r.added).toHaveLength(1);
    expect(r.drawn()).toHaveLength(0);
  });

  it("never asks the viewport to see through the body", () => {
    const r = rig([10]);
    r.t.mode = "cut";
    r.push(-5);
    r.tool.cancel();
    expect(r.setPeek).not.toHaveBeenCalled();
  });
});

describe("Press/Pull keeps the pushed faces tinted", () => {
  // The mark is the centroid of the first of a face's two equal triangles
  const where = (id: number, along: number): P => corner(id, 2 / 3, 1 / 3, along);

  it("selects each pushed face where it now stands once a preview lands", () => {
    const r = rig([12, 13]);
    r.stands.push({ at: where(12, 2.5), id: 40 }, { at: where(13, 2.5), id: 41 });
    r.push(2.5);
    r.land(2.5);
    expect(r.selectOnlyFaces.mock.calls).toEqual([[[40, 41]]]);
  });

  it("tints a face Ctrl clicked in along with the first", () => {
    const r = rig([10]);
    r.ctrlAdd(13);
    r.stands.push({ at: where(10, 2.5), id: 60 }, { at: where(13, 2.5), id: 61 });
    r.push(2.5);
    r.land(2.5);
    expect(r.selectOnlyFaces.mock.calls).toEqual([[[60, 61]]]);
  });

  it("finds the first face again when a face is Ctrl clicked in after a preview landed", () => {
    const r = rig([10]);
    r.push(2.5);
    r.land(2.5);
    moved[10] = 2.5;
    r.ctrlAdd(13);
    r.stands.push({ at: where(10, 2.5), id: 60 }, { at: where(13, 2.5), id: 61 });
    r.push(2.5);
    r.land(2.5);
    expect(r.selectOnlyFaces.mock.calls).toEqual([[[60, 61]]]);
  });

  it("follows the distance the engine answered, not the one typed since", () => {
    const r = rig([10]);
    r.stands.push({ at: where(10, 3), id: 50 }, { at: where(10, 7), id: 51 });
    r.push(7);
    r.land(3);
    expect(r.selectOnlyFaces.mock.calls).toEqual([[[50]]]);
  });

  it("finds a face that went in at the negative distance", () => {
    const r = rig([10]);
    r.stands.push({ at: where(10, -4), id: 60 });
    r.push(-4);
    r.land(-4);
    expect(r.selectOnlyFaces.mock.calls).toEqual([[[60]]]);
  });

  it("tints the face where the last good preview left it when a push is refused", () => {
    const r = rig([10]);
    r.stands.push({ at: where(10, 2.5), id: 40 });
    r.push(2.5);
    r.land(2.5);
    r.push(-6);
    r.refuse(-6);
    expect(r.selectOnlyFaces.mock.calls).toEqual([[[40]], [[40]]]);
  });

  it("tints nothing for a refusal before any preview landed", () => {
    const r = rig([10]);
    r.stands.push({ at: where(10, 0), id: 40 });
    r.push(-6);
    r.refuse(-6);
    expect(r.selectOnlyFaces).not.toHaveBeenCalled();
  });

  it("keeps the selection when no pushed face is found, and takes the ones that are", () => {
    const lost = rig([10]);
    lost.push(2);
    lost.land(2);
    expect(lost.selectOnlyFaces).not.toHaveBeenCalled();
    const some = rig([12, 13]);
    some.stands.push({ at: where(13, 1.5), id: 71 });
    some.push(1.5);
    some.land(1.5);
    expect(some.selectOnlyFaces.mock.calls).toEqual([[[71]]]);
  });

  it("does nothing for the state replayed on subscribing, a refused push or a round face", () => {
    const r = rig([10]);
    r.stands.push({ at: where(10, 2), id: 80 });
    r.push(2);
    const idle = { building: false, result: {}, previewBuilt: [{ id: "p1", distance: 2 }] };
    for (const fn of [...listeners]) fn(idle as never);
    for (const fn of [...listeners]) fn({ building: true, result: null } as never);
    expect(r.selectOnlyFaces).not.toHaveBeenCalled();
    const bore = rig([ROUND]);
    bore.push(1);
    bore.land(1);
    expect(bore.selectOnlyFaces).not.toHaveBeenCalled();
  });

  it("stops listening when the tool closes", () => {
    const r = rig([10]);
    r.stands.push({ at: where(10, 2), id: 90 });
    r.push(2);
    expect(listeners).toHaveLength(1);
    r.tool.cancel();
    expect(listeners).toHaveLength(0);
  });
});
