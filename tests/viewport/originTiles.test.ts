import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  CORNER_SEGMENTS,
  GHOST_SHARE,
  LABEL_BOX_PX,
  MIN_TILE_SCALE,
  OriginTiles,
  RIM_INK_MIX,
  RIM_PX,
  TILE_LOOK,
  TILE_ORDER,
  TILE_SHAPE,
  LABEL_HOT_SCALE,
  labelInk,
  mixHex,
  tilePose,
  tileStates,
  type TilePose,
  type TileState,
} from "../../src/viewport/originTiles";
import { AXIS_COLOR } from "../../src/viewport/originTriad";
import { SQUIRCLE_EXPONENT, roundedSquareCorners } from "../../src/viewport/cornerProfile";
import { markOverlay, overlayLayer } from "../../src/viewport/overlayKinds";
import type { Plane3 } from "../../src/types";

const PLANES: Plane3[] = ["XY", "XZ", "YZ"];
const ASYM = { sizePx: 37, gapPx: 5, octant: { x: -1, y: 1, z: -1 } } as const;

type Mat = THREE.MeshBasicMaterial | THREE.SpriteMaterial;
const matOf = (o: THREE.Object3D) => (o as THREE.Mesh).material as Mat;
const child = (o: THREE.Object3D, role: string) => o.children.find((c) => c.userData.role === role)!;

function opacities(t: OriginTiles) {
  const out: Record<string, { fill: number; ghost: number; rim: number; label: number }> = {};
  for (const k of PLANES) {
    const fill = t.planes[k];
    const of = (role: string) => matOf(child(fill, role)).opacity;
    out[k] = { fill: matOf(fill).opacity, ghost: of("ghost"), rim: of("rim"), label: of("label") };
  }
  return out;
}

function homeCamera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(30, 1.5, 1, 5000);
  cam.up.set(0, 0, 1);
  cam.position.set(80, -120, 90);
  cam.lookAt(12, -7, 3);
  cam.updateMatrixWorld(true);
  return cam;
}

function topCamera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-50, 50, 30, -30, 1, 1000);
  cam.position.set(5, -3, 200);
  cam.lookAt(5, -3, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

const labelOpacity = (t: OriginTiles) =>
  Object.fromEntries(PLANES.map((k) => [k, matOf(child(t.planes[k], "label")).opacity]));

const look = (s: TileState) => ({ ...TILE_LOOK[s], ghost: TILE_LOOK[s].fill * GHOST_SHARE });

/** The axis aligned box a placed tile fills, in the group's pixel frame. */
function tileBox(p: TilePose, size: number) {
  const lo = [0, 1, 2].map((i) => p.centre[i]! - ((Math.abs(p.u[i]!) + Math.abs(p.v[i]!)) * size) / 2);
  const hi = [0, 1, 2].map((i) => p.centre[i]! + ((Math.abs(p.u[i]!) + Math.abs(p.v[i]!)) * size) / 2);
  return { lo, hi };
}

function boxDistance(a: ReturnType<typeof tileBox>, b: ReturnType<typeof tileBox>): number {
  const d = [0, 1, 2].map((i) => Math.max(0, a.lo[i]! - b.hi[i]!, b.lo[i]! - a.hi[i]!));
  return Math.hypot(...d);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TILE_SHAPE", () => {
  // A rail tile is 40 px with a 17 px squircle corner (--rail-tile, --float-tile-radius).
  it("is clearly bigger than a rail tile and rounds like one, with the app's squircle", () => {
    expect(TILE_SHAPE).toEqual({
      sizePx: 85,
      gapPx: 0,
      radiusPx: 36,
      exponent: SQUIRCLE_EXPONENT,
      octant: { x: 1, y: 1, z: 1 },
    });
    expect(TILE_SHAPE.radiusPx / TILE_SHAPE.sizePx).toBeCloseTo(17 / 40, 2);
    expect(TILE_SHAPE.sizePx * MIN_TILE_SCALE).toBeGreaterThanOrEqual(40);
  });
});

describe("tilePose", () => {
  it("puts each default tile in the positive quadrant of its two axes, its corner on the origin", () => {
    expect(PLANES.map((k) => tilePose(k, TILE_SHAPE))).toEqual([
      { centre: [42.5, 42.5, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] },
      { centre: [42.5, 0, 42.5], u: [1, 0, 0], v: [0, 0, 1], normal: [0, -1, 0] },
      { centre: [0, 42.5, 42.5], u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0] },
    ]);
  });

  it("follows the size, gap and octant it is given", () => {
    const shape = { ...TILE_SHAPE, ...ASYM };
    expect(PLANES.map((k) => tilePose(k, shape))).toEqual([
      { centre: [-23.5, 23.5, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] },
      { centre: [-23.5, 0, -23.5], u: [1, 0, 0], v: [0, 0, 1], normal: [0, -1, 0] },
      { centre: [0, 23.5, -23.5], u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0] },
    ]);
  });

  it("keeps the tiles apart by the gap, and touching at gap 0", () => {
    for (const [gap, want] of [
      [5, 5 * Math.SQRT2],
      [6, 6 * Math.SQRT2],
      [0, 0],
    ] as const) {
      const shape = { ...TILE_SHAPE, sizePx: 37, gapPx: gap };
      const boxes = PLANES.map((k) => tileBox(tilePose(k, shape), 37));
      const d = [
        boxDistance(boxes[0]!, boxes[1]!),
        boxDistance(boxes[0]!, boxes[2]!),
        boxDistance(boxes[1]!, boxes[2]!),
      ];
      for (const x of d) expect(x).toBeCloseTo(want, 12);
    }
  });
});

describe("a tile on its plane", () => {
  const L = TILE_SHAPE.sizePx;
  /** The two axes a plane spans and its normal, as indices into a world point. */
  const AXES: Record<Plane3, [number, number, number]> = { XY: [0, 1, 2], XZ: [0, 2, 1], YZ: [1, 2, 0] };
  const tidy = (n: number) => Math.round(n * 1e6) / 1e6 + 0;
  const worldPoints = (mesh: THREE.Mesh) => {
    const pos = mesh.geometry.getAttribute("position");
    return Array.from({ length: pos.count }, (_, i) =>
      new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).toArray().map(tidy),
    );
  };
  /** Indices of the cyclic neighbours of the point at (0, 0) on the plane. */
  const sides = (pts: number[][], a: number, b: number) => {
    const i = pts.findIndex((p) => p[a] === 0 && p[b] === 0);
    expect(i).toBeGreaterThanOrEqual(0);
    const at = (j: number) => pts[(j + pts.length) % pts.length]!;
    return [at(i - 1), at(i + 1)].map((p) => [p[a], p[b]]).sort((p, q) => p[0]! - q[0]!);
  };

  it("has its corner at the origin and runs its two edges straight along the positive axes", () => {
    const t = new OriginTiles(new THREE.Scene());
    t.group.updateMatrixWorld(true);
    for (const k of PLANES) {
      const [a, b, n] = AXES[k];
      for (const mesh of [t.planes[k], child(t.planes[k], "rim") as THREE.Mesh]) {
        const pts = worldPoints(mesh);
        for (const p of pts) {
          expect(p[n]).toBe(0);
          for (const c of [p[a]!, p[b]!]) {
            expect(c).toBeGreaterThanOrEqual(0);
            expect(c).toBeLessThanOrEqual(L);
          }
        }
        const has = (x: number, y: number) => pts.some((p) => p[a] === x && p[b] === y);
        expect([has(0, 0), has(L, 0), has(0, L), has(L, L)]).toEqual([true, true, true, false]);
      }
      expect(sides(worldPoints(t.planes[k]), a, b)).toEqual([
        [0, L],
        [L, 0],
      ]);
    }
    t.dispose();
  });

  it("picks along the same outline, its corner on the origin and its sides on the arrows", () => {
    const t = new OriginTiles(new THREE.Scene());
    const eyes: Record<Plane3, { at: THREE.Vector3Tuple; up: THREE.Vector3Tuple }> = {
      XY: { at: [0, 0, 300], up: [0, 1, 0] },
      XZ: { at: [0, -300, 0], up: [0, 0, 1] },
      YZ: { at: [300, 0, 0], up: [0, 0, 1] },
    };
    const rect = { left: 0, top: 0, width: 400, height: 400 };
    for (const k of PLANES) {
      const cam = new THREE.OrthographicCamera(-200, 200, 200, -200, 1, 1000);
      cam.position.set(...eyes[k].at);
      cam.up.set(...eyes[k].up);
      cam.lookAt(0, 0, 0);
      cam.updateMatrixWorld(true);
      const [a, b] = AXES[k];
      const tip = (axis: number) => [0, 1, 2].map((i) => (i === axis ? L : 0)) as THREE.Vector3Tuple;
      const screen = (p: THREE.Vector3Tuple) => {
        const s = new THREE.Vector3(...p).project(cam);
        return [tidy((s.x * 0.5 + 0.5) * 400), tidy((-s.y * 0.5 + 0.5) * 400)];
      };
      const ring = t.onScreen({ camera: cam, rect }).find((s) => s.plane === k)!.outline.map((p) => [tidy(p.x), tidy(p.y)]);
      const i = ring.findIndex(([x, y]) => x === 200 && y === 200);
      expect(i).toBeGreaterThanOrEqual(0);
      const near = [ring[(i + ring.length - 1) % ring.length], ring[(i + 1) % ring.length]];
      expect(near).toContainEqual(screen(tip(a)));
      expect(near).toContainEqual(screen(tip(b)));
    }
    t.dispose();
  });
});

describe("tileStates and colours", () => {
  it("lights the hovered tile and dims the others", () => {
    expect(tileStates(null)).toEqual({ XY: "idle", XZ: "idle", YZ: "idle" });
    expect(tileStates("XZ")).toEqual({ XY: "dim", XZ: "hot", YZ: "dim" });
  });

  it("mixes colours per channel", () => {
    expect(mixHex(0x4d8dff, 0xf6f0e4, 0)).toBe(0x4d8dff);
    expect(mixHex(0x4d8dff, 0xf6f0e4, 1)).toBe(0xf6f0e4);
    expect(mixHex(0x4d8dff, 0xf6f0e4, 0.4)).toBe(0x91b5f4);
    expect(mixHex(0x102030, 0x405060, 0.5)).toBe(0x283848);
  });

  it("inks a name in the token that reads on the ground drawn", () => {
    const noir = { text: 0xf6f0e4, bg: 0x0b0912 };
    const solar = { text: 0x073642, bg: 0xeee8d5 };
    expect(labelInk(noir.bg, noir.text, noir.bg)).toBe(noir.text);
    expect(labelInk(0xd8dbe0, noir.text, noir.bg)).toBe(noir.bg);
    expect(labelInk(solar.bg, solar.text, solar.bg)).toBe(solar.text);
    expect(labelInk(0x0e1013, solar.text, solar.bg)).toBe(solar.bg);
    // White and black read almost alike on a mid grey: 0x75 is the last grey white wins on.
    expect(labelInk(0x757575, 0xffffff, 0x000000)).toBe(0xffffff);
    expect(labelInk(0x767676, 0xffffff, 0x000000)).toBe(0x000000);
    expect(labelInk(0x757575, 0x000000, 0xffffff)).toBe(0xffffff);
  });
});

describe("OriginTiles", () => {
  it("builds three hidden tiles tagged with their plane, coloured by the normal axis", () => {
    const scene = new THREE.Scene();
    const t = new OriginTiles(scene);
    markOverlay(t.group, "origin");
    expect(t.group.parent).toBe(scene);
    expect(
      PLANES.map((k) => ({
        plane: t.planes[k].userData.plane,
        color: (t.planes[k].material as THREE.MeshBasicMaterial).color.getHex(),
        visible: t.planes[k].visible,
        parent: t.planes[k].parent === t.group,
        roles: t.planes[k].children.map((c) => c.userData.role),
      })),
    ).toEqual([
      { plane: "XY", color: AXIS_COLOR.z, visible: false, parent: true, roles: ["ghost", "rim", "label"] },
      { plane: "XZ", color: AXIS_COLOR.y, visible: false, parent: true, roles: ["ghost", "rim", "label"] },
      { plane: "YZ", color: AXIS_COLOR.x, visible: false, parent: true, roles: ["ghost", "rim", "label"] },
    ]);
    const layers = new Set<number>();
    t.group.traverse((o) => layers.add(o.layers.mask));
    expect([...layers]).toEqual([1 << overlayLayer("origin")]);
    t.setShown(true);
    expect(PLANES.map((k) => t.planes[k].visible)).toEqual([true, true, true]);
    t.setShown(false);
    expect(PLANES.map((k) => t.planes[k].visible)).toEqual([false, false, false]);
    t.dispose();
    expect(t.group.parent).toBe(null);
  });

  it("draws a faint ghost through bodies, then the depth tested fill and rim, then the name", () => {
    const t = new OriginTiles(new THREE.Scene());
    const fill = t.planes.XZ;
    const flags = (o: THREE.Object3D) => {
      const m = matOf(o);
      return {
        order: o.renderOrder,
        depthTest: m.depthTest,
        depthWrite: m.depthWrite,
        transparent: m.transparent,
        offset: m.polygonOffset ? [m.polygonOffsetFactor, m.polygonOffsetUnits] : null,
      };
    };
    expect([flags(child(fill, "ghost")), flags(fill), flags(child(fill, "rim")), flags(child(fill, "label"))]).toEqual([
      { order: 950, depthTest: false, depthWrite: false, transparent: true, offset: null },
      { order: 951, depthTest: true, depthWrite: false, transparent: true, offset: [-1, -4] },
      { order: 952, depthTest: true, depthWrite: false, transparent: true, offset: [-1, -4] },
      { order: 953, depthTest: false, depthWrite: false, transparent: true, offset: null },
    ]);
    expect((child(fill, "ghost") as THREE.Mesh).geometry).toBe(fill.geometry);
    expect(Math.max(...Object.values(TILE_ORDER))).toBeLessThan(998);
    t.dispose();
  });

  it("sets each part's opacity from the hover state, and a show starts idle", () => {
    const t = new OriginTiles(new THREE.Scene());
    t.setShown(true);
    expect(opacities(t)).toEqual({ XY: look("idle"), XZ: look("idle"), YZ: look("idle") });
    t.hover("XZ");
    expect(opacities(t)).toEqual({ XY: look("dim"), XZ: look("hot"), YZ: look("dim") });
    t.hover(null);
    expect(opacities(t)).toEqual({ XY: look("idle"), XZ: look("idle"), YZ: look("idle") });
    t.hover("YZ");
    t.setShown(false);
    t.setShown(true);
    expect(opacities(t)).toEqual({ XY: look("idle"), XZ: look("idle"), YZ: look("idle") });
    t.dispose();
  });

  it("holds the tiles to screen pixels, shrinking with a small part down to the floor", () => {
    const t = new OriginTiles(new THREE.Scene());
    const at = (pws: number | null, diag: number | null) => {
      t.update(pws, diag, homeCamera());
      const label = child(t.planes.XY, "label");
      return { scale: t.group.scale.x, label: [label.scale.x, label.scale.y] };
    };
    const extent = TILE_SHAPE.gapPx + TILE_SHAPE.sizePx;
    // k = diag / pws * 0.45 / extent, held between the floor and 1.
    const diagFor = (k: number, pws: number) => (k * extent * pws) / 0.45;
    const expectAt = (pws: number, diag: number | null, k: number) => {
      const got = at(pws, diag);
      expect(got.scale).toBeCloseTo(pws * k, 12);
      expect(got.label[0]).toBeCloseTo(LABEL_BOX_PX.w / k, 9);
      expect(got.label[1]).toBeCloseTo(LABEL_BOX_PX.h / k, 9);
    };
    expectAt(0.37, null, 1);
    expectAt(0.37, 250, 1);
    expectAt(0.37, diagFor(1, 0.37), 1);
    expectAt(0.37, diagFor(0.83, 0.37), 0.83);
    expectAt(0.37, diagFor(MIN_TILE_SCALE, 0.37), MIN_TILE_SCALE);
    expectAt(0.37, diagFor(0.2, 0.37), MIN_TILE_SCALE);
    expectAt(1.9, diagFor(0.71, 1.9), 0.71);
    expect(at(null, 250).scale).toBe(0);
    t.dispose();
  });

  it("keeps every name at its full look edge on, and grows the hovered one", () => {
    const t = new OriginTiles(new THREE.Scene());
    t.setShown(true);
    t.update(0.37, null, topCamera());
    expect(labelOpacity(t)).toEqual({ XY: TILE_LOOK.idle.label, XZ: TILE_LOOK.idle.label, YZ: TILE_LOOK.idle.label });
    t.hover("XZ");
    expect(labelOpacity(t)).toEqual({ XY: TILE_LOOK.dim.label, XZ: TILE_LOOK.hot.label, YZ: TILE_LOOK.dim.label });
    const size = (k: Plane3) => child(t.planes[k], "label").scale.toArray().slice(0, 2);
    expect(size("XZ")).toEqual([LABEL_BOX_PX.w * LABEL_HOT_SCALE, LABEL_BOX_PX.h * LABEL_HOT_SCALE]);
    expect(size("XY")).toEqual([LABEL_BOX_PX.w, LABEL_BOX_PX.h]);
    const colour = (k: Plane3, role: string) => matOf(child(t.planes[k], role)).color.getHex();
    expect(colour("XZ", "label")).toBe(colour("XZ", "rim"));
    expect(colour("XY", "label")).not.toBe(colour("XY", "rim"));
    t.hover(null);
    expect(size("XZ")).toEqual([LABEL_BOX_PX.w, LABEL_BOX_PX.h]);
    expect(colour("XZ", "label")).toBe(colour("XY", "label"));
    t.dispose();
  });

  it("rims each tile in its axis colour pulled towards the ink, and inks the names", () => {
    const t = new OriginTiles(new THREE.Scene());
    const colours = () =>
      PLANES.map((k) => [
        matOf(child(t.planes[k], "rim")).color.getHex(),
        matOf(child(t.planes[k], "label")).color.getHex(),
      ]);
    const noirText = 0xf6f0e4;
    const noirGround = 0x0b0912;
    t.applyTheme(noirGround);
    expect(colours()).toEqual([
      [mixHex(AXIS_COLOR.z, noirText, RIM_INK_MIX), noirText],
      [mixHex(AXIS_COLOR.y, noirText, RIM_INK_MIX), noirText],
      [mixHex(AXIS_COLOR.x, noirText, RIM_INK_MIX), noirText],
    ]);
    t.applyTheme(0xd8dbe0);
    expect(colours()).toEqual([
      [mixHex(AXIS_COLOR.z, noirGround, RIM_INK_MIX), noirGround],
      [mixHex(AXIS_COLOR.y, noirGround, RIM_INK_MIX), noirGround],
      [mixHex(AXIS_COLOR.x, noirGround, RIM_INK_MIX), noirGround],
    ]);
    t.dispose();
  });

  it("paints the names on the first show, and again only until the font has loaded", () => {
    const drawn: string[] = [];
    const ctx = {
      clearRect: () => {},
      fillText: (s: string) => drawn.push(s),
      strokeText: () => {},
      fillStyle: "",
      strokeStyle: "",
      lineJoin: "",
      lineWidth: 0,
      font: "",
      textAlign: "",
      textBaseline: "",
    };
    let fontReady = false;
    vi.stubGlobal("document", {
      createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
      fonts: { check: () => fontReady },
    });
    const t = new OriginTiles(new THREE.Scene());
    expect(drawn).toEqual([]);
    t.setShown(false);
    expect(drawn).toEqual([]);
    t.setShown(true);
    expect(drawn).toEqual(["XY", "XZ", "YZ"]);
    expect({ fill: ctx.fillStyle, font: ctx.font.includes("Space Grotesk"), size: ctx.font.includes("60px") }).toEqual({
      fill: "#ffffff",
      font: true,
      size: true,
    });
    fontReady = true;
    t.setShown(true);
    expect(drawn).toEqual(["XY", "XZ", "YZ", "XY", "XZ", "YZ"]);
    t.setShown(true);
    expect(drawn.length).toBe(6);
    const map = (child(t.planes.YZ, "label") as THREE.Sprite).material.map!;
    expect(map.image as { width: number; height: number }).toMatchObject({ width: 152, height: 88 });
    t.dispose();
  });

  it("skips the paint without a 2D context", () => {
    vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => null }) });
    const t = new OriginTiles(new THREE.Scene());
    t.setShown(true);
    expect((child(t.planes.XY, "label") as THREE.Sprite).material.map!.image).toBe(null);
    t.dispose();
  });

  it("reshapes in place, moving the tiles and freeing the old geometry", () => {
    const t = new OriginTiles(new THREE.Scene());
    const meshes = PLANES.map((k) => t.planes[k]);
    const rims = PLANES.map((k) => child(t.planes[k], "rim") as THREE.Mesh);
    const first = [...meshes, ...rims].map((m) => m.geometry);
    const spies = first.map((g) => vi.spyOn(g, "dispose"));
    t.reshape(ASYM);
    expect(PLANES.map((k) => t.planes[k])).toEqual(meshes);
    PLANES.forEach((k, i) => expect(t.planes[k]).toBe(meshes[i]));
    expect(spies.map((s) => s.mock.calls.length)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(PLANES.map((k) => (child(t.planes[k], "ghost") as THREE.Mesh).geometry === t.planes[k].geometry)).toEqual([
      true,
      true,
      true,
    ]);
    const box = (m: THREE.Mesh) => {
      m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox!;
      return [b.min.x, b.min.y, b.max.x, b.max.y];
    };
    expect(PLANES.map((k) => box(t.planes[k]))).toEqual([
      [-18.5, -18.5, 18.5, 18.5],
      [-18.5, -18.5, 18.5, 18.5],
      [-18.5, -18.5, 18.5, 18.5],
    ]);
    expect(PLANES.map((k) => t.planes[k].position.toArray())).toEqual([
      [-23.5, 23.5, 0],
      [-23.5, 0, -23.5],
      [0, 23.5, -23.5],
    ]);
    const second = [...meshes, ...rims].map((m) => m.geometry);
    const again = second.map((g) => vi.spyOn(g, "dispose"));
    t.reshape({ radiusPx: 4, exponent: 2.5 });
    expect(again.map((s) => s.mock.calls.length)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(PLANES.map((k) => t.planes[k].position.toArray())).toEqual([
      [-23.5, 23.5, 0],
      [-23.5, 0, -23.5],
      [0, 23.5, -23.5],
    ]);
    t.dispose();
  });

  it("triangulates the fill as the whole tile and the rim as a thin ring", () => {
    const t = new OriginTiles(new THREE.Scene());
    const area = (g: THREE.BufferGeometry) => {
      const pos = g.getAttribute("position");
      const idx = g.getIndex()!;
      const tri = new THREE.Triangle();
      let a = 0;
      for (let i = 0; i < idx.count; i += 3) {
        tri.a.fromBufferAttribute(pos, idx.getX(i));
        tri.b.fromBufferAttribute(pos, idx.getX(i + 1));
        tri.c.fromBufferAttribute(pos, idx.getX(i + 2));
        a += tri.getArea();
      }
      return a;
    };
    // Only the far corner, local (+, +) for XY, is rounded.
    const square = (size: number, leg: number) => {
      const pts = roundedSquareCorners(size, [0, leg, 0, 0], TILE_SHAPE.exponent, CORNER_SEGMENTS);
      let a = 0;
      pts.forEach((p, i) => {
        const q = pts[(i + 1) % pts.length]!;
        a += p[0] * q[1] - q[0] * p[1];
      });
      return a / 2;
    };
    const outer = square(TILE_SHAPE.sizePx, TILE_SHAPE.radiusPx);
    const inner = square(TILE_SHAPE.sizePx - 2 * RIM_PX, TILE_SHAPE.radiusPx - RIM_PX);
    expect(area(t.planes.XY.geometry)).toBeCloseTo(outer, 3);
    expect(area((child(t.planes.XY, "rim") as THREE.Mesh).geometry)).toBeCloseTo(outer - inner, 3);
    t.dispose();
  });

  it("turns each tile's local square onto its plane", () => {
    const t = new OriginTiles(new THREE.Scene());
    t.group.scale.setScalar(0.37);
    t.group.updateMatrixWorld(true);
    const corner = (k: Plane3) =>
      new THREE.Vector3(20, 10, 0)
        .applyMatrix4(t.planes[k].matrixWorld)
        .toArray()
        .map((n) => Math.round(n * 1e9) / 1e9 + 0);
    expect(PLANES.map(corner)).toEqual([
      [62.5 * 0.37, 52.5 * 0.37, 0].map((n) => Math.round(n * 1e9) / 1e9),
      [62.5 * 0.37, 0, 52.5 * 0.37].map((n) => Math.round(n * 1e9) / 1e9),
      [0, 62.5 * 0.37, 52.5 * 0.37].map((n) => Math.round(n * 1e9) / 1e9),
    ]);
    t.dispose();
  });
});
