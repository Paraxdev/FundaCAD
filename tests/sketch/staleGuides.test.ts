// A pair of amber dashed lines stayed over the grid after a sketch ended with the cursor lined up with two points,
// through discards and other documents: the overlay outlives every sketch and document, and ending a sketch cleared
// the snap marker but never the alignment guides drawn with it. Esc, Exit Sketching or a click on a profile all end
// the sketch with the cursor still on the canvas, so no pointer leave cleared them either.
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { SketchMode } from "../../src/sketch/sketchMode";
import { SketchOverlay } from "../../src/sketch/overlay";
import type { SnapGuide } from "../../src/sketch/snap";

const inert: unknown = new Proxy(function () {}, {
  get: (_t, k) => (k === "then" || typeof k === "symbol" ? undefined : inert),
  apply: () => inert,
});

type Internals = {
  showSnap(hit: { kind: string; world: THREE.Vector3; p: THREE.Vector2; guides: SnapGuide[] } | null): void;
  cancel(): void;
  finish(commit?: boolean): void;
};

const withInert = <T extends object>(t: T): T =>
  new Proxy(t, { get: (o, k, r) => (k in o ? Reflect.get(o, k, r) : inert) });

/** SketchMode's real methods off the prototype with a real overlay; everything else answers inertly. */
function openSketch(overlay: SketchOverlay) {
  const target = Object.create(SketchMode.prototype) as Record<string, unknown>;
  Object.assign(target, {
    viewport: withInert({
      pixelWorldSize: () => 0.1,
      projectToScreen: () => ({ x: 0, y: 0 }),
      camera: new THREE.PerspectiveCamera(),
    }),
    active: true,
    tool: "line",
    overlay,
    plane: overlay.planeFor("XY"),
    store: null,
    selected: new Set<string>(),
    pendingBindings: new Map(),
    navigatedDuringSketch: true,
    viewSquare: true,
    onState: null,
    onViewSquare: null,
  });
  return withInert(target) as unknown as Internals;
}

/** Dashed lines left in the overlay, in its scene group. */
function dashedLines(overlay: SketchOverlay): THREE.Line[] {
  const out: THREE.Line[] = [];
  overlay.group.traverse((o) => {
    if (o instanceof THREE.Line && o.material instanceof THREE.LineDashedMaterial) out.push(o);
  });
  return out;
}

/** The cursor at (20, 10) lined up with a corner at (0, 10) and another at (20, 0). */
function lineUp(s: Internals) {
  s.showSnap({
    kind: "align",
    world: new THREE.Vector3(20, 10, 0),
    p: new THREE.Vector2(20, 10),
    guides: [
      { from: new THREE.Vector2(0, 10), axis: "x" },
      { from: new THREE.Vector2(20, 0), axis: "y" },
    ],
  });
}

describe("ending a sketch takes its alignment guides with it", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("draws the two guides while the cursor is lined up", () => {
    const overlay = new SketchOverlay();
    lineUp(openSketch(overlay));
    expect(dashedLines(overlay)).toHaveLength(2);
  });

  for (const [how, end] of [
    ["cancelled", (s: Internals) => s.cancel()],
    ["finished", (s: Internals) => s.finish(false)],
  ] as const) {
    it(`leaves no guide in the scene once the sketch is ${how} with the cursor still lined up`, () => {
      const overlay = new SketchOverlay();
      const s = openSketch(overlay);
      lineUp(s);
      end(s);
      expect(dashedLines(overlay)).toHaveLength(0);
    });
  }
});

describe("SketchOverlay.clearTransient", () => {
  it("drops guides, the rubber band and the snap marker, and keeps the committed sketches", () => {
    const overlay = new SketchOverlay();
    const plane = overlay.planeFor("XY");
    overlay.update({
      version: 4,
      parameters: {},
      features: [
        { id: "s1", type: "sketch", plane: "XY", entities: [{ type: "line", id: "c", x1: 0, y1: 0, x2: 9, y2: 0 }] },
      ],
    } as never);
    const drawn = () => overlay.group.children.reduce((n, g) => n + g.children.length, 0);
    const marker = overlay.group.children.find((o) => o instanceof THREE.Mesh)!;
    const committed = drawn();
    expect(committed).toBeGreaterThan(0);
    overlay.setGuides([[new THREE.Vector2(0, 0), new THREE.Vector2(5, 5)]], plane);
    overlay.setPreview([new THREE.Line(new THREE.BufferGeometry())]);
    overlay.setSnap(new THREE.Vector3(1, 2, 0));
    expect([drawn(), marker.visible]).toEqual([committed + 2, true]);
    overlay.clearTransient();
    expect(dashedLines(overlay)).toHaveLength(0);
    expect([drawn(), marker.visible]).toEqual([committed, false]);
  });
});
