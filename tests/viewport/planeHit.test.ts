import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { LABEL_BOX_PX, OriginTiles, TILE_SIZE_PX, type ScreenFrame } from "../../src/viewport/originTiles";
import {
  HIT_MIN_COARSE_PX,
  HIT_MIN_PX,
  pickPlaneOnScreen,
  placeLabels,
  planeHitMinPx,
  polygonDistance,
  type P2,
  type PlaneOnScreen,
} from "../../src/viewport/planeHit";
import type { Plane3 } from "../../src/types";

const PLANES: Plane3[] = ["XY", "XZ", "YZ"];
const RECT = { left: 100, top: 50, width: 800, height: 600 };

/** An orthographic camera at one world unit per pixel, so a full size tile is 68 px on screen. */
function orthoFrom(dir: [number, number, number]): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, 1, 5000);
  const d = new THREE.Vector3(...dir).normalize();
  cam.up.set(0, 0, 1);
  if (Math.abs(d.z) > 0.999) cam.up.set(0, 1, 0);
  cam.position.copy(d.multiplyScalar(1000));
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

const TOP: [number, number, number] = [0, 0, 1];
// The user's view: the YZ tile foreshortened to about two thirds, the XZ tile almost edge on.
const OBLIQUE: [number, number, number] = [0.66, -0.07, 0.75];

function tilesAt(dir: [number, number, number]) {
  const t = new OriginTiles(new THREE.Scene());
  t.setShown(true);
  const camera = orthoFrom(dir);
  t.update(1, null, camera, RECT);
  const frame: ScreenFrame = { camera, rect: RECT };
  const screen = t.onScreen(frame);
  const labels = t.labelsOnScreen(frame, screen);
  return { t, frame, screen, labels };
}

/** The side of the largest axis aligned square of pixels that all pick `plane`, scanned around the origin. */
function largestSquare(
  screen: PlaneOnScreen[],
  labels: Record<string, P2>,
  origin: P2,
  minPx: number,
): Record<Plane3, number> {
  const R = 160;
  const n = 2 * R;
  const out = { XY: 0, XZ: 0, YZ: 0 } as Record<Plane3, number>;
  const runs: Record<Plane3, Uint16Array[]> = {
    XY: [new Uint16Array(n), new Uint16Array(n)],
    XZ: [new Uint16Array(n), new Uint16Array(n)],
    YZ: [new Uint16Array(n), new Uint16Array(n)],
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const hit = pickPlaneOnScreen(
        screen,
        labels,
        { x: origin.x - R + i + 0.5, y: origin.y - R + j + 0.5 },
        minPx,
        LABEL_BOX_PX,
      );
      for (const k of PLANES) {
        const [prev, cur] = runs[k] as [Uint16Array, Uint16Array];
        cur[i] = hit?.plane === k ? (i && j ? 1 + Math.min(prev[i]!, cur[i - 1]!, prev[i - 1]!) : 1) : 0;
        out[k] = Math.max(out[k], cur[i]!);
      }
    }
    for (const k of PLANES) runs[k].reverse();
  }
  return out;
}

const originOf = (frame: ScreenFrame): P2 => {
  const n = new THREE.Vector3().project(frame.camera);
  return {
    x: (n.x * 0.5 + 0.5) * frame.rect.width + frame.rect.left,
    y: (-n.y * 0.5 + 0.5) * frame.rect.height + frame.rect.top,
  };
};

function narrowWidth(t: PlaneOnScreen): number {
  let w = Infinity;
  for (let d = 0; d < 180; d++) {
    const a = (d * Math.PI) / 180;
    const proj = t.outline.map((p) => p.x * Math.cos(a) + p.y * Math.sin(a));
    w = Math.min(w, Math.max(...proj) - Math.min(...proj));
  }
  return w;
}

function rectsOverlap(a: P2, b: P2) {
  return Math.abs(a.x - b.x) < LABEL_BOX_PX.w && Math.abs(a.y - b.y) < LABEL_BOX_PX.h;
}

describe("planeHitMinPx", () => {
  it("is 44 px for a mouse and 48 px for a coarse pointer or after a touch", () => {
    expect([HIT_MIN_PX, HIT_MIN_COARSE_PX]).toEqual([44, 48]);
    expect(planeHitMinPx(false, null)).toBe(44);
    expect(planeHitMinPx(false, "mouse")).toBe(44);
    expect(planeHitMinPx(false, "pen")).toBe(44);
    expect(planeHitMinPx(true, "mouse")).toBe(48);
    expect(planeHitMinPx(false, "touch")).toBe(48);
  });
});

describe("hit area on screen", () => {
  it("gives every plane at least a 44 px square at the oblique view, the near edge on tile included", () => {
    const { t, frame, screen, labels } = tilesAt(OBLIQUE);
    const xz = screen.find((s) => s.plane === "XZ")!;
    expect(narrowWidth(xz)).toBeLessThan(12);
    const sq = largestSquare(screen, labels, originOf(frame), HIT_MIN_PX);
    for (const k of PLANES) expect(sq[k]).toBeGreaterThanOrEqual(HIT_MIN_PX);
    t.dispose();
  });

  it("gives the two tiles seen exactly edge on from the top a full size target", () => {
    const { t, frame, screen, labels } = tilesAt(TOP);
    expect(PLANES.map((k) => Math.round(narrowWidth(screen.find((s) => s.plane === k)!)))).toEqual([
      TILE_SIZE_PX,
      0,
      0,
    ]);
    const sq = largestSquare(screen, labels, originOf(frame), HIT_MIN_PX);
    for (const k of PLANES) expect(sq[k]).toBeGreaterThanOrEqual(HIT_MIN_PX);
    t.dispose();
  });

  it("grows to 48 px for a coarse pointer", () => {
    for (const dir of [TOP, OBLIQUE]) {
      const { t, frame, screen, labels } = tilesAt(dir);
      const sq = largestSquare(screen, labels, originOf(frame), HIT_MIN_COARSE_PX);
      for (const k of PLANES) expect(sq[k]).toBeGreaterThanOrEqual(HIT_MIN_COARSE_PX);
      t.dispose();
    }
  });

  it("pads a lone edge on tile to exactly the minimum across it", () => {
    const line: PlaneOnScreen = {
      plane: "XZ",
      centre: { x: 0, y: 0 },
      outline: [
        { x: -34, y: 0 },
        { x: 34, y: 0 },
      ],
      su: { x: 34, y: 0 },
      sv: { x: 0, y: 0 },
      facing: 0,
    };
    const at = (x: number, y: number, min: number) => pickPlaneOnScreen([line], {}, { x, y }, min, LABEL_BOX_PX);
    expect(at(0, 21.9, 44)?.plane).toBe("XZ");
    expect(at(0, -21.9, 44)).toMatchObject({ plane: "XZ", part: "pad" });
    expect(at(0, 22.1, 44)).toBe(null);
    expect(at(0, 23.9, 48)?.plane).toBe("XZ");
    expect(at(0, 24.1, 48)).toBe(null);
    expect(at(33.9, 0, 44)).toMatchObject({ plane: "XZ", distance: 0 });
    expect(at(34.1, 0, 44)).toBe(null);
  });

  it("picks nothing at the origin from the top or the home side, nor far away", () => {
    for (const dir of [TOP, [1, -1.5, 1.1] as [number, number, number]]) {
      const { t, frame, screen, labels } = tilesAt(dir);
      const o = originOf(frame);
      expect(pickPlaneOnScreen(screen, labels, o, HIT_MIN_PX, LABEL_BOX_PX)).toBe(null);
      expect(pickPlaneOnScreen(screen, labels, { x: o.x + 250, y: o.y + 250 }, HIT_MIN_PX, LABEL_BOX_PX)).toBe(null);
      t.dispose();
    }
  });

  it("matches the drawn tile under the pointer through OriginTiles.pick, and nothing once hidden", () => {
    const { t, frame, screen } = tilesAt([1, -1.5, 1.1]);
    for (const s of screen) expect(t.pick(s.centre.x, s.centre.y, frame, HIT_MIN_PX)?.plane).toBe(s.plane);
    t.setShown(false);
    const xy = screen[0]!.centre;
    expect(t.pick(xy.x, xy.y, frame, HIT_MIN_PX)).toBe(null);
    t.dispose();
  });
});

describe("overlapping targets", () => {
  const square = (plane: Plane3, cx: number, half: number, facing: number): PlaneOnScreen => ({
    plane,
    centre: { x: cx, y: 0 },
    outline: [
      { x: cx - half, y: -half },
      { x: cx + half, y: -half },
      { x: cx + half, y: half },
      { x: cx - half, y: half },
    ],
    su: { x: half, y: 0 },
    sv: { x: 0, y: half },
    facing,
  });

  it("go to the plane whose drawn tile is nearest the pointer", () => {
    // Two 20 px tiles 30 px apart: their 44 px pads overlap between them.
    const a = square("XY", 0, 10, 0.2);
    const b = square("YZ", 30, 10, 0.9);
    const pick = (x: number) => pickPlaneOnScreen([a, b], {}, { x, y: 0 }, HIT_MIN_PX, LABEL_BOX_PX);
    expect(pick(12)).toMatchObject({ plane: "XY", distance: 2, part: "pad" });
    expect(pick(18)).toMatchObject({ plane: "YZ", distance: 2, part: "pad" });
    expect(pick(5)).toMatchObject({ plane: "XY", distance: 0, part: "tile" });
  });

  it("then to the one facing the camera most", () => {
    const a = square("XY", 0, 10, 0.2);
    const b = square("YZ", 30, 10, 0.9);
    expect(pickPlaneOnScreen([a, b], {}, { x: 15, y: 0 }, HIT_MIN_PX, LABEL_BOX_PX)?.plane).toBe("YZ");
    const c = square("XZ", 0, 10, 0.95);
    expect(pickPlaneOnScreen([a, c], {}, { x: 0, y: 0 }, HIT_MIN_PX, LABEL_BOX_PX)?.plane).toBe("XZ");
  });

  it("goes to the drawn tile in front of a neighbour's pad at the oblique and top views", () => {
    for (const dir of [TOP, OBLIQUE]) {
      const { t, screen, labels } = tilesAt(dir);
      for (const s of screen) {
        if (narrowWidth(s) < 30) continue;
        expect(pickPlaneOnScreen(screen, labels, s.centre, HIT_MIN_PX, LABEL_BOX_PX)?.plane).toBe(s.plane);
      }
      t.dispose();
    }
  });
});

describe("names", () => {
  it("sit in the middle of a tile that holds them", () => {
    const { t, screen, labels } = tilesAt([1, -1.5, 1.1]);
    for (const s of screen) {
      expect(labels[s.plane]!.x).toBeCloseTo(s.centre.x, 9);
      expect(labels[s.plane]!.y).toBeCloseTo(s.centre.y, 9);
    }
    t.dispose();
  });

  it("move beside an edge on tile, clear of the other names and tiles", () => {
    for (const dir of [TOP, OBLIQUE]) {
      const { t, screen, labels } = tilesAt(dir);
      const thin = screen.filter((s) => narrowWidth(s) < 12);
      expect(thin.length).toBeGreaterThan(0);
      for (const s of thin) {
        const at = labels[s.plane]!;
        expect(Math.hypot(at.x - s.centre.x, at.y - s.centre.y)).toBeGreaterThan(LABEL_BOX_PX.h / 2);
        for (const o of screen) {
          if (o.plane === s.plane) continue;
          expect(rectsOverlap(at, labels[o.plane]!)).toBe(false);
          expect(polygonDistance(at, o.outline)).toBeGreaterThan(0);
        }
      }
      t.dispose();
    }
  });

  it("pick their plane, even the name of a tile seen edge on", () => {
    for (const dir of [TOP, OBLIQUE]) {
      const { t, frame, screen, labels } = tilesAt(dir);
      for (const s of screen) {
        const at = labels[s.plane]!;
        expect(t.pick(at.x, at.y, frame, HIT_MIN_PX)).toMatchObject({ plane: s.plane, distance: 0 });
      }
      for (const s of screen.filter((x) => narrowWidth(x) < 12))
        expect(t.pick(labels[s.plane]!.x, labels[s.plane]!.y, frame, HIT_MIN_PX)?.part).toBe("label");
      t.dispose();
    }
  });

  it("are drawn where they are picked", () => {
    const { t, frame, labels } = tilesAt(TOP);
    for (const k of PLANES) {
      const sprite = t.planes[k].children.find((c) => c.userData.role === "label")!;
      const p = sprite.getWorldPosition(new THREE.Vector3()).project(frame.camera);
      expect((p.x * 0.5 + 0.5) * RECT.width + RECT.left).toBeCloseTo(labels[k]!.x, 6);
      expect((-p.y * 0.5 + 0.5) * RECT.height + RECT.top).toBeCloseTo(labels[k]!.y, 6);
    }
    t.dispose();
  });

  it("slide out smoothly as a tile turns edge on", () => {
    const tile = (squash: number): PlaneOnScreen => {
      const h = 34;
      const ry = h * squash;
      return {
        plane: "XZ",
        centre: { x: 0, y: 0 },
        outline: [
          { x: -h, y: -ry },
          { x: h, y: -ry },
          { x: h, y: ry },
          { x: -h, y: ry },
        ],
        su: { x: h, y: 0 },
        sv: { x: 0, y: ry },
        facing: squash,
      };
    };
    const shift = (squash: number) => Math.abs(placeLabels([tile(squash)], LABEL_BOX_PX).XZ!.y);
    expect(shift(1)).toBe(0);
    expect(shift(0.5)).toBe(0);
    const steps = Array.from({ length: 41 }, (_, i) => shift(i / 100));
    for (let i = 1; i < steps.length; i++) expect(Math.abs(steps[i]! - steps[i - 1]!)).toBeLessThan(4);
    expect(steps[0]).toBeGreaterThan(LABEL_BOX_PX.h / 2);
  });
});
