// While an extrude is open the profile's outline runs up its height: rings at the ends, a line along every corner, the
// accent for an add and the error colour for a cut, gone with the tool.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createPinia, setActivePinia } from "pinia";
import { ExtrudeTool } from "../../src/features/extrudeTool";
import { SketchPlane } from "../../src/sketch/plane";
import { rectCorners } from "../../src/sketch/region";
import { edgeSelectColor } from "../../src/viewport/highlight";
import { themeColor } from "../../src/viewport/themeColors";
import type { Viewport } from "../../src/viewport/viewport";
import type { DocumentStore } from "../../src/document/store";

type P = [number, number, number];
interface Internals {
  distance: number;
  taper: number;
  updatePreview(): void;
  setSymmetric(on: boolean): void;
}

function lenient<T>(own: Record<string, unknown>): T {
  return new Proxy(own, { get: (t, k) => (k in t ? t[k as string] : () => undefined) }) as unknown as T;
}

// A slanted plane off the origin: normal (0, 0.6, 0.8), u = +X, so v = (0, 0.8, -0.6).
const plane = new SketchPlane({ origin: [10, -4, 7], normal: [0, 0.6, 0.8], xdir: [1, 0, 0] });
const n = plane.n;
const lift = (x: number, y: number, along: number): P => {
  const q = plane.to3D(x, y).addScaledVector(n, along);
  return [q.x, q.y, q.z];
};
// A corner of the 6 x 3 rectangle at (2, 1), moved `inset` toward its middle
const world = (x: number, y: number, along = 0, inset = 0): P =>
  lift(x < 5 ? x + inset : x - inset, y < 2.5 ? y + inset : y - inset, along);
const round = (p: ArrayLike<number>): P => [0, 1, 2].map((i) => Math.round(p[i]! * 1e4) / 1e4) as P;

const corners: [number, number][] = [
  [2, 1],
  [8, 1],
  [8, 4],
  [2, 4],
];
const ringAt = (along: number, inset = 0) => corners.map(([x, y]) => world(x, y, along, inset));
const closedSegs = (pts: P[]): [P, P][] => pts.map((p, i) => [p, pts[(i + 1) % pts.length]!]);
const lineSegs = (pts: P[]): [P, P][] => pts.slice(1).map((p, i) => [pts[i]!, p]);
const sides = (from: number, to: number, toInset = 0) =>
  corners.map(([x, y]) => [world(x, y, from), world(x, y, to, toInset)] as [P, P]);

/** Direction and order free: one string per segment. */
const key = (s: [P, P]) =>
  JSON.stringify([round(s[0]), round(s[1])].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]));
const keys = (segs: [P, P][]) => segs.map(key).sort();

const flat = (a: THREE.InterleavedBufferAttribute): P[] =>
  Array.from({ length: a.count }, (_, i) => [a.getX(i), a.getY(i), a.getZ(i)] as P);

const tools: ExtrudeTool[] = [];
let scene: THREE.Object3D[] = [];

function rig(opts: { holes?: THREE.Vector2[][] } = {}) {
  scene = [];
  const wr = {
    sketchId: "f1",
    region: {
      sketchId: "f1",
      loop: rectCorners(5, 2.5, 6, 3),
      holes: opts.holes ?? [],
      centroid: new THREE.Vector2(5, 2.5),
      interior: new THREE.Vector2(2.5, 1.5),
    },
    plane,
    centroid3D: plane.to3D(5, 2.5),
    interior3D: plane.to3D(2.5, 1.5),
  };
  let picked: unknown[] = [wr];
  const overlay = {
    regions: [wr],
    update: vi.fn(),
    selectedRegions: () => picked,
    toggleRegionSelection: vi.fn(() => {
      picked = [];
    }),
    setHoverRegion: vi.fn(),
    clearRegionSelection: () => {
      picked = [];
    },
  };
  const canvas = document.createElement("canvas");
  const viewport = lenient<Viewport>({
    suspendPicking: false,
    domElement: canvas,
    pixelWorldSize: () => 0.1,
    pointInSolid: () => false,
    setPeek: () => new Set(),
    addToScene: (o: THREE.Object3D) => void scene.push(o),
    removeFromScene: (o: THREE.Object3D) => {
      scene = scene.filter((x) => x !== o);
    },
  });
  const added: unknown[] = [];
  const store = lenient<DocumentStore>({
    document: { features: [{ id: "f1", type: "sketch" }], parameters: {} },
    buildState: { building: false, result: null },
    hasPreview: false,
    previewError: null,
    nextId: () => "f9",
    hiddenBodyIds: () => undefined,
    boundExpr: () => null,
    isParamBound: () => false,
    onBuild: () => () => {},
    onSessionBuild: () => () => {},
    addFeature: (f: unknown) => added.push(f),
  });
  const tool = new ExtrudeTool(viewport, overlay as never, store);
  tools.push(tool);
  Object.assign(tool, { positionDim: () => {} });
  const t = tool as unknown as Internals;
  const drawn = () => scene.filter((o) => (o as { isLineSegments2?: boolean }).isLineSegments2) as THREE.Mesh[];
  const outline = () => {
    const geo = drawn()[0]?.geometry;
    if (!geo) return null;
    const a = flat(geo.getAttribute("instanceStart") as THREE.InterleavedBufferAttribute);
    const b = flat(geo.getAttribute("instanceEnd") as THREE.InterleavedBufferAttribute);
    return a.map((p, i) => [p, b[i]!] as [P, P]);
  };
  const colour = () => {
    const c = drawn()[0]!.geometry.getAttribute("instanceColorStart") as THREE.InterleavedBufferAttribute;
    return new THREE.Color(c.getX(0), c.getY(0), c.getZ(0)).getHex();
  };
  const depth = (d: number) => {
    t.distance = d;
    t.updatePreview();
  };
  return { tool, t, overlay, canvas, start: () => tool.start(vi.fn()), drawn, outline, colour, depth, added };
}

const near = (a: number, b: number) => [16, 8, 0].every((s) => Math.abs(((a >> s) & 0xff) - ((b >> s) & 0xff)) <= 2);

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  for (const tool of tools.splice(0)) if ((tool as unknown as { active: boolean }).active) tool.cancel();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("Extrude outline", () => {
  it("runs a ring at each end and a line up every corner of the profile", () => {
    const r = rig();
    r.start();
    r.depth(5);
    const want = [...closedSegs(ringAt(0)), ...closedSegs(ringAt(5)), ...sides(0, 5)];
    expect(r.drawn()).toHaveLength(2);
    expect(keys(r.outline()!)).toEqual(keys(want));
    expect(near(r.colour(), edgeSelectColor())).toBe(true);
  });

  it("follows the depth as it changes, 3 mm, 9 mm and back", () => {
    const r = rig();
    r.start();
    for (const d of [3, 9, 5]) {
      r.depth(d);
      const want = [...closedSegs(ringAt(0)), ...closedSegs(ringAt(d)), ...sides(0, d)];
      expect(keys(r.outline()!)).toEqual(keys(want));
      expect(r.drawn()).toHaveLength(2);
    }
  });

  it("has a ring at each end of a symmetric extrude and sides through the sketch plane", () => {
    const r = rig();
    r.start();
    r.t.setSymmetric(true);
    r.depth(4);
    const want = [
      ...closedSegs(ringAt(-4)),
      ...closedSegs(ringAt(4)),
      ...corners.flatMap(([x, y]) => lineSegs([world(x, y, -4), world(x, y, 0), world(x, y, 4)])),
    ];
    expect(keys(r.outline()!)).toEqual(keys(want));
  });

  it("leans the end ring in with a taper, the sides with it", () => {
    const r = rig();
    r.start();
    r.t.taper = 10;
    r.depth(5);
    const inset = 5 * Math.tan((10 * Math.PI) / 180);
    const want = [...closedSegs(ringAt(0)), ...closedSegs(ringAt(5, inset)), ...sides(0, 5, inset)];
    expect(keys(r.outline()!)).toEqual(keys(want));
  });

  it("keeps a hole's own rings and sides, and a taper grows the hole", () => {
    const hole = [new THREE.Vector2(4, 2), new THREE.Vector2(4, 3), new THREE.Vector2(6, 3), new THREE.Vector2(6, 2)];
    const r = rig({ holes: [hole] });
    r.start();
    r.t.taper = 10;
    r.depth(5);
    const i = 5 * Math.tan((10 * Math.PI) / 180);
    const at = (a: number, grow = 0) =>
      [
        [4 - grow, 2 - grow],
        [4 - grow, 3 + grow],
        [6 + grow, 3 + grow],
        [6 + grow, 2 - grow],
      ].map(([x, y]) => lift(x!, y!, a));
    const want = [
      ...closedSegs(ringAt(0)),
      ...closedSegs(ringAt(5, i)),
      ...sides(0, 5, i),
      ...closedSegs(at(0)),
      ...closedSegs(at(5, i)),
      ...at(0).map((p, k) => [p, at(5, i)[k]!] as [P, P]),
    ];
    expect(keys(r.outline()!)).toEqual(keys(want));
  });

  it("is drawn in the error colour and into the material for a cut", () => {
    const r = rig();
    r.start();
    r.depth(-8);
    const want = [...closedSegs(ringAt(0)), ...closedSegs(ringAt(-8)), ...sides(0, -8)];
    expect(keys(r.outline()!)).toEqual(keys(want));
    expect(near(r.colour(), edgeSelectColor())).toBe(false);
    expect(near(r.colour(), themeColor("--error", 0xe23b3b))).toBe(true);
    r.depth(6);
    expect(near(r.colour(), edgeSelectColor())).toBe(true);
  });

  it("draws nothing at zero depth", () => {
    const r = rig();
    r.start();
    r.depth(5);
    expect(r.drawn()).toHaveLength(2);
    r.depth(0);
    expect(r.drawn()).toHaveLength(0);
    r.depth(2);
    expect(r.drawn()).toHaveLength(2);
  });

  it("is gone after a commit", () => {
    const r = rig();
    r.start();
    r.depth(5);
    expect(r.drawn()).toHaveLength(2);
    (r.tool as unknown as { commit(): void }).commit();
    expect(r.added).toHaveLength(1);
    expect(r.drawn()).toHaveLength(0);
  });

  it("is gone after a cancel, and a second extrude starts without the first one's lines", () => {
    const r = rig();
    r.start();
    r.depth(5);
    r.tool.cancel();
    expect(r.drawn()).toHaveLength(0);
    const r2 = rig();
    r2.start();
    r2.depth(7);
    expect(r2.drawn()).toHaveLength(2);
    expect(keys(r2.outline()!)).toEqual(keys([...closedSegs(ringAt(0)), ...closedSegs(ringAt(7)), ...sides(0, 7)]));
  });

  it("is hidden once every area is Ctrl clicked off", () => {
    const r = rig();
    r.start();
    r.depth(5);
    expect(r.drawn()).toHaveLength(2);
    Object.assign(r.tool, { regionUnder: () => r.overlay.regions[0], hitGizmo: () => false, hitTaper: () => false });
    const down = { clientX: 1, clientY: 1, button: 0, ctrlKey: true, bubbles: true, cancelable: true };
    r.canvas.dispatchEvent(new PointerEvent("pointerdown", down));
    expect(r.overlay.toggleRegionSelection).toHaveBeenCalledTimes(1);
    expect(r.drawn()).toHaveLength(0);
  });
});
