// A face-anchored sketch must survive being REOPENED.
//
// Storing the face is what lets the sidecar re-derive the plane every rebuild,
// so the sketch follows the body face it was drawn on instead of recording where
// that face used to be. The trap is that the anchor has to ride through THREE
// places in one class: enter() takes it, enter() re-adopts it from the feature
// when editing, and snapshotFeature() writes it back out. snapshotFeature is
// what a re-edit commits, so dropping it in any one of the three means: open the
// sketch, change nothing, close it — and the anchor is silently gone, the plane
// is baked at wherever it stood, and the sealed-cavity bug is back with no
// message at all.
//
// `planeId` is asserted alongside because it is the SAME three lines, already
// shipped, and it is the pattern this one copies. If a future edit breaks the
// shape, both fail together and the cause is obvious.
//
// Driving a real SketchMode needs WebGL, so `this` is a hand-built stand-in —
// but the METHODS under test are the real ones, taken off the prototype. What is
// faked is the viewport/overlay/solver around them, never the round-trip.

import { describe, it, expect, beforeEach } from "vitest";
import { SketchMode } from "../../src/sketch/sketchMode";
import { SketchPlane } from "../../src/sketch/plane";
import type { CadDocument, Feature, PlaneDef, Selector } from "../../src/types";

const PLANE: PlaneDef = { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] };
const SEL: Selector = { kind: "face", by: "nearest", point: [9.5, 0, 10], body: "body1" };
const ANCHOR = { selector: SEL, at: [9.5, 0, 10] as [number, number, number] };

// vitest runs *.test.ts in node (no DOM, on purpose — see vitest.config.ts);
// enter() registers its key handler on window.
(globalThis as unknown as { window: unknown }).window ??= {
  addEventListener() {},
  removeEventListener() {},
  innerWidth: 1000,
  innerHeight: 800,
};
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame ??=
  (() => 0) as unknown;
(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame ??=
  (() => {}) as unknown;

/** A SketchMode whose collaborators are stubs, so enter()/snapshotFeature() can
 *  run. Everything here is a dependency of entering a sketch, not part of what
 *  is under test — the two methods themselves come from the real prototype. */
function makeSketch(doc: CadDocument) {
  const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, unknown>;
  Object.assign(s, {
    fonts: ["stub"], // non-empty: skips the async font fetch
    entities: [],
    constraints: [],
    patterns: [],
    selected: new Set<string>(),
    pendingBindings: new Map(),
    history: { reset() {} },
    patternFlow: { resetForEnter() {}, flushOnFinish() {} },
    dims: { clearSelection() {} },
    gridFocus: { set() {} },
    overlay: {
      planeFor: (spec: PlaneDef | string) => new SketchPlane(spec as PlaneDef),
      clearRegionSelection() {},
      update() {},
      setGuides() {},
    },
    viewport: {
      suspendPicking: false,
      enterSketchView() {},
      visibleEdgeLines: () => [],
      modelDiagonal: () => 0,
      domElement: { addEventListener() {}, removeEventListener() {} },
      onZoomScale: null,
    },
    // prototype methods that touch three.js / the solver, stubbed as own props
    addGrid() {},
    refreshActive() {},
    armPreEdit() {},
    setTool() {},
    setViewLocked() {},
    requestSolve() {},
    viewLocked: false,
  });
  return { s, store: { document: doc, nextId: () => "s99" } as never };
}

const circle = (s: SketchMode) =>
  (s as unknown as { entities: unknown[] }).entities.push({
    type: "circle", id: "c1", x: 0, y: 0, radius: 3,
  });

describe("a face-anchored sketch round-trips through enter, snapshot and enter", () => {
  let doc: CadDocument;
  beforeEach(() => {
    doc = { version: 9, parameters: {}, features: [] } as unknown as CadDocument;
  });

  it("keeps the face and the planeId the first time the sketch is committed", () => {
    const { s, store } = makeSketch(doc);
    s.enter(PLANE, store, undefined, "dp1", ANCHOR);
    circle(s);
    const f = s.snapshotFeature() as Extract<Feature, { type: "sketch" }>;
    expect(f.face).toEqual(SEL);
    expect(f.at).toEqual(ANCHOR.at);
    expect(f.planeId).toBe("dp1");
  });

  it("keeps them when the SAVED sketch is reopened and closed unchanged", () => {
    // The re-bake trap: editFeature passes neither the face nor the planeId (it
    // only knows the id), so the round-trip depends entirely on enter()
    // re-adopting them from the stored feature.
    const { s: a, store: sa } = makeSketch(doc);
    a.enter(PLANE, sa, undefined, "dp1", ANCHOR);
    circle(a);
    const first = a.snapshotFeature() as Extract<Feature, { type: "sketch" }>;
    doc.features = [{ ...first, id: "s1" }];

    const { s, store } = makeSketch(doc);
    s.enter(PLANE, store, "s1"); // editFeature's call shape: id only
    const again = s.snapshotFeature() as Extract<Feature, { type: "sketch" }>;
    expect(again.id).toBe("s1");
    expect(again.face).toEqual(SEL);
    expect(again.at).toEqual(ANCHOR.at);
    expect(again.planeId).toBe("dp1");
  });

  it("writes no face key at all for a sketch on a base plane", () => {
    // Legacy compat, the whole rule: no anchor picked, not one byte added. This
    // is also the control for every assertion above — if a sketch on XY came out
    // carrying a face, they would all pass for the wrong reason.
    const { s, store } = makeSketch(doc);
    s.enter("XY" as unknown as PlaneDef, store);
    circle(s);
    const f = s.snapshotFeature() as Extract<Feature, { type: "sketch" }>;
    expect("face" in f).toBe(false);
    expect("at" in f).toBe(false);
    expect("planeId" in f).toBe(false);
  });

  it("drops the anchor when a saved sketch had none", () => {
    // Reopening an old document must not invent an anchor, and must not inherit
    // one left on the instance by a previous session.
    doc.features = [{
      id: "s1", type: "sketch", plane: PLANE,
      entities: [{ type: "circle", id: "c1", x: 0, y: 0, radius: 3 }],
    } as unknown as Feature];
    const { s, store } = makeSketch(doc);
    s.enter(PLANE, store, undefined, undefined, ANCHOR);  // a previous session
    s.enter(PLANE, store, "s1");                          // ...then this one
    const f = s.snapshotFeature() as Extract<Feature, { type: "sketch" }>;
    expect("face" in f).toBe(false);
  });
});
