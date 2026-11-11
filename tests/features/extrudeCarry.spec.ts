// Extrude carries on: once its depth is set, a click on a face or an edge finishes it as one feature and hands the pick
// on. While the depth follows the pointer, in an edit, on empty space or on a refused preview nothing carries.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createPinia, setActivePinia } from "pinia";
import { ExtrudeTool } from "../../src/features/extrudeTool";
import { carryWords, type CarryHost } from "../../src/features/carryOn";
import { SketchPlane } from "../../src/sketch/plane";
import { rectCorners } from "../../src/sketch/region";
import { endPickSession, resetTreePicks, routeTreeClick, treePickWaiting } from "../../src/ui/treePick";
import type { Viewport } from "../../src/viewport/viewport";
import type { DocumentStore } from "../../src/document/store";

const prompts = vi.hoisted(() => [] as (string | null)[]);
vi.mock("../../src/ui/prompt", async (actual) => ({
  ...(await actual<typeof import("../../src/ui/prompt")>()),
  setPrompt: (text: string | null) => prompts.push(text),
}));

interface Internals {
  distance: number;
  grabbing: boolean;
  downPos: { x: number; y: number };
  updatePreview(): void;
}

const plane = new SketchPlane({ origin: [10, -4, 7], normal: [0, 0.6, 0.8], xdir: [1, 0, 0] });
const inside = plane.to3D(2.5, 1.5);
const region = [inside.x, inside.y, inside.z];

const tri = (a: number[], b: number[], c: number[]) =>
  new THREE.Triangle(new THREE.Vector3(...a), new THREE.Vector3(...b), new THREE.Vector3(...c));
const SMALL = tri([15, 2, 3], [16, 2, 3], [15, 3, 3.5]);
const LARGE = tri([15, 2, 3], [19, 4, 3], [15, 8, 3.5]);
const LARGE_CENTRE = [(15 + 19 + 15) / 3, (2 + 4 + 8) / 3, (3 + 3 + 3.5) / 3];
const EDGE_POINTS = [
  [12, 1, 5],
  [14, 1, 5],
  [14, 1, 9],
];
const faceHit = { kind: "face", faceId: 4, selector: {}, point: [15, 3, 3] };
const edgeHit = { kind: "edge", edge: { id: "e7", body: "body1", points: EDGE_POINTS }, selector: {} };

const tools: ExtrudeTool[] = [];

function lenient(own: Record<string, unknown>) {
  return new Proxy(own, { get: (t, k) => (k in t ? t[k as string] : () => undefined) });
}

function rig(opts: { editing?: boolean } = {}) {
  const wr = {
    sketchId: "f1",
    region: {
      sketchId: "f1",
      loop: rectCorners(5, 2.5, 6, 3),
      holes: [],
      centroid: new THREE.Vector2(5, 2.5),
      interior: new THREE.Vector2(2.5, 1.5),
    },
    plane,
    centroid3D: plane.to3D(5, 2.5),
    interior3D: inside,
  };
  const overlay = {
    regions: [wr],
    update: vi.fn(),
    selectedRegions: () => [wr],
    toggleRegionSelection: vi.fn(),
    selectRegionsByPoints: vi.fn(),
    setHoverRegion: vi.fn(),
    clearRegionSelection: () => {},
  };
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const under = { hit: null as unknown };
  const lit: unknown[] = [];
  const viewport = lenient({
    suspendPicking: false,
    domElement: canvas,
    pixelWorldSize: () => 0.1,
    pointInSolid: () => false,
    rayFrom: () => ({ ray: new THREE.Ray(new THREE.Vector3(3, 2, 60), new THREE.Vector3(0.1, 0, -1).normalize()) }),
    pickEntity: () => under.hit,
    hoverEntity: (hit: unknown) => void lit.push(hit),
    faceTriangles: (id: number) => (id === 4 ? [SMALL, LARGE] : []),
  }) as unknown as Viewport;
  const state = {
    document: {
      features: [
        { id: "f1", type: "sketch" },
        ...(opts.editing
          ? [{ id: "e1", type: "extrude", sketch: "f1", distance: 6, operation: "join", regions: [region] }]
          : []),
      ],
      parameters: {},
    },
    buildState: { building: false, result: null as unknown },
    hasPreview: false,
    previewError: null as string | null,
  };
  const calls = { added: [] as { distance: number }[], replaced: [] as unknown[], verify: [] as unknown[][] };
  const store = lenient({
    ...state,
    nextId: () => "f9",
    hiddenBodyIds: () => undefined,
    boundExpr: () => null,
    isParamBound: () => false,
    onBuild: () => () => {},
    onSessionBuild: () => () => {},
    addFeature: (f: { distance: number }) => void calls.added.push(f),
    replaceFeature: (...a: unknown[]) => void calls.replaced.push(a),
    verifyCommit: (...a: unknown[]) => void calls.verify.push(a),
  }) as unknown as DocumentStore;
  Object.defineProperties(store, {
    hasPreview: { get: () => state.hasPreview },
    previewError: { get: () => state.previewError },
    buildState: { get: () => state.buildState },
  });
  const hints: string[] = [];
  const after = vi.fn();
  const route = vi.fn((pick) => routeTreeClick(pick, { busyHint: () => null, hint: (m) => void hints.push(m) }));
  const host: CarryHost = { route, after };
  const tool = new ExtrudeTool(viewport, overlay as never, store);
  tools.push(tool);
  Object.assign(tool, { positionDim: () => {}, hitGizmo: () => false, hitTaper: () => false });
  tool.carry = host;
  const t = tool as unknown as Internals;
  const depth = (d: number) => {
    t.distance = d;
    t.updatePreview();
  };
  const pointer = (type: string, x = 300, y = 200) =>
    canvas.dispatchEvent(
      new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }),
    );
  // The arrow dragged and let go: the depth is set.
  const settle = (d: number) => {
    t.grabbing = true;
    t.downPos = { x: 0, y: 0 };
    depth(d);
    pointer("pointerup", 40, 40);
    state.hasPreview = true;
  };
  const type = (text: string) => {
    const input = document.querySelector<HTMLInputElement>(".dim-input input")!;
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const begin = () => (opts.editing ? tool.startEdit("e1", vi.fn()) : tool.start(vi.fn()));
  return { tool, t, state, calls, hints, host, route, after, under, lit, pointer, settle, type, begin, depth };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  prompts.length = 0;
});
afterEach(() => {
  for (const tool of tools.splice(0)) if ((tool as unknown as { active: boolean }).active) tool.cancel();
  resetTreePicks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("Extrude carries on to the next pick", () => {
  it("a click on a face once the depth is set writes one extrude and hands the face's inner point on", () => {
    const r = rig();
    r.begin();
    r.settle(12);
    r.under.hit = faceHit;
    r.pointer("pointerdown");
    expect(r.calls.added).toEqual([expect.objectContaining({ id: "f9", type: "extrude", distance: 12 })]);
    expect(r.after).toHaveBeenCalledTimes(1);
    expect(r.after).toHaveBeenCalledWith({ kind: "added", id: "f9" }, { kind: "face", point: LARGE_CENTRE });
    expect(r.route).toHaveBeenCalledTimes(1);
    expect(r.tool.active).toBe(false);
    expect(treePickWaiting()).toBe(false);
  });

  it("a click on an edge hands the edge's middle on", () => {
    const r = rig();
    r.begin();
    r.settle(-7);
    r.under.hit = edgeHit;
    r.pointer("pointerdown");
    expect(r.calls.added).toEqual([expect.objectContaining({ id: "f9", distance: -7 })]);
    expect(r.after).toHaveBeenCalledWith({ kind: "added", id: "f9" }, { kind: "edge", point: [14, 1, 6] });
  });

  it("a depth typed in the box counts as set", () => {
    const r = rig();
    r.begin();
    r.type("9");
    r.state.hasPreview = true;
    r.under.hit = faceHit;
    r.pointer("pointerdown");
    expect(r.calls.added).toEqual([expect.objectContaining({ distance: 9 })]);
    expect(r.after).toHaveBeenCalledTimes(1);
  });

  it("a click on empty space commits as it always did and carries nothing", () => {
    const r = rig();
    r.begin();
    r.settle(12);
    r.under.hit = null;
    r.pointer("pointerdown");
    expect(r.calls.added).toEqual([expect.objectContaining({ distance: 12 })]);
    expect(r.route).not.toHaveBeenCalled();
    expect(r.after).not.toHaveBeenCalled();
  });

  it("while the depth still follows the pointer a click on a face only commits", () => {
    const r = rig();
    r.begin();
    r.depth(8);
    r.under.hit = faceHit;
    r.pointer("pointerdown");
    expect(r.calls.added).toEqual([expect.objectContaining({ distance: 8 })]);
    expect(r.route).not.toHaveBeenCalled();
    expect(r.after).not.toHaveBeenCalled();
  });

  it("an edit opens no session and a click on a face finishes the edit as before", () => {
    const r = rig({ editing: true });
    r.begin();
    expect(treePickWaiting()).toBe(false);
    r.settle(11);
    r.under.hit = faceHit;
    r.pointer("pointerdown");
    expect(r.calls.replaced).toHaveLength(1);
    expect(r.route).not.toHaveBeenCalled();
    expect(r.after).not.toHaveBeenCalled();
  });

  it("a refused preview refuses the click with its reason, commits nothing and keeps the step open", () => {
    const r = rig();
    r.begin();
    r.settle(5);
    r.state.previewError = "profile self intersects";
    r.under.hit = faceHit;
    r.pointer("pointerdown");
    expect(r.calls.added).toEqual([]);
    expect(r.after).not.toHaveBeenCalled();
    expect(r.hints).toEqual([carryWords.refused("profile self intersects")]);
    expect(r.tool.active).toBe(true);
    expect(treePickWaiting()).toBe(true);
    r.state.previewError = null;
    r.pointer("pointerdown");
    expect(r.calls.added).toEqual([expect.objectContaining({ distance: 5 })]);
    expect(r.after).toHaveBeenCalledTimes(1);
  });

  it("a preview still building refuses the click and commits nothing", () => {
    const r = rig();
    r.begin();
    r.settle(5);
    r.state.buildState = { building: true, result: null };
    r.under.hit = edgeHit;
    r.pointer("pointerdown");
    expect(r.calls.added).toEqual([]);
    expect(r.calls.verify).toEqual([]);
    expect(r.hints).toEqual([carryWords.wait()]);
    expect(r.tool.active).toBe(true);
    r.state.buildState = { building: false, result: null };
    r.pointer("pointerdown");
    expect(r.calls.added).toHaveLength(1);
    expect(r.after).toHaveBeenCalledTimes(1);
  });

  it("a typed value that cannot be read refuses the click and commits nothing", () => {
    const r = rig();
    r.begin();
    r.settle(5);
    r.type("abc");
    r.under.hit = faceHit;
    r.pointer("pointerdown");
    expect(r.calls.added).toEqual([]);
    expect(r.hints).toEqual([carryWords.badValue()]);
    expect(r.tool.active).toBe(true);
  });

  it("a depth typed as zero adds nothing, closes the step and carries on", () => {
    const r = rig();
    r.begin();
    r.type("0");
    r.under.hit = faceHit;
    r.pointer("pointerdown");
    expect(r.calls.added).toEqual([]);
    expect(r.after).toHaveBeenCalledWith({ kind: "nothing" }, { kind: "face", point: LARGE_CENTRE });
    expect(r.tool.active).toBe(false);
  });

  it("a row or bracket pick while the depth follows the pointer is refused until the depth is set", () => {
    const r = rig();
    r.begin();
    r.depth(7.5);
    const hints: string[] = [];
    const deps = { busyHint: () => null, hint: (m: string) => void hints.push(m) };
    expect(routeTreeClick({ kind: "face", faceId: 4 }, deps)).toBe("refused");
    expect(hints).toEqual([carryWords.depthFirst()]);
    expect(r.calls.added).toEqual([]);
    expect(r.after).not.toHaveBeenCalled();
    expect(r.tool.active).toBe(true);
    r.type("7.5");
    r.state.hasPreview = true;
    expect(routeTreeClick({ kind: "edge", edge: edgeHit.edge as never }, deps)).toBe("taken");
    expect(r.calls.added).toEqual([expect.objectContaining({ distance: 7.5 })]);
    expect(r.after).toHaveBeenCalledWith({ kind: "added", id: "f9" }, { kind: "edge", point: [14, 1, 6] });
  });

  it("a row of the Geometry list or a bracket pick reaches the same rule through the session", () => {
    const r = rig();
    r.begin();
    r.settle(6);
    const answer = routeTreeClick({ kind: "face", faceId: 4 }, { busyHint: () => null, hint: () => {} });
    expect(answer).toBe("taken");
    expect(r.calls.added).toEqual([expect.objectContaining({ distance: 6 })]);
    expect(r.after).toHaveBeenCalledWith({ kind: "added", id: "f9" }, { kind: "face", point: LARGE_CENTRE });
  });

  it("a row that is neither a face nor an edge is refused and the step stays open", () => {
    const r = rig();
    r.begin();
    r.settle(6);
    const hints: string[] = [];
    const deps = { busyHint: () => null, hint: (m: string) => void hints.push(m) };
    expect(routeTreeClick({ kind: "body", id: "body1" }, deps)).toBe("refused");
    expect(hints).toHaveLength(1);
    expect(r.calls.added).toEqual([]);
    expect(r.tool.active).toBe(true);
  });
});

describe("the session of an open Extrude", () => {
  it("opens with the drag phase and ends with the tool", () => {
    const r = rig();
    expect(treePickWaiting()).toBe(false);
    r.begin();
    expect(treePickWaiting()).toBe(true);
    r.tool.cancel();
    expect(treePickWaiting()).toBe(false);
  });

  it("is ended by another pick session starting, which cancels the step without writing", () => {
    const r = rig();
    const done = vi.fn();
    r.tool.start(done);
    r.settle(5);
    endPickSession();
    expect(r.tool.active).toBe(false);
    expect(done).toHaveBeenCalledWith(null);
    expect(r.calls.added).toEqual([]);
  });
});

describe("hover and prompt while the depth is set", () => {
  it("lights the face or edge a click would carry to, and only once the depth is set", () => {
    const r = rig();
    r.begin();
    r.settle(12);
    r.under.hit = faceHit;
    r.pointer("pointermove", 310, 210);
    r.under.hit = edgeHit;
    r.pointer("pointermove", 320, 220);
    r.under.hit = null;
    r.pointer("pointermove", 330, 230);
    expect(r.lit).toEqual([faceHit, edgeHit, null]);
  });

  it("lights nothing while the depth follows the pointer", () => {
    const r = rig();
    r.begin();
    r.under.hit = faceHit;
    r.pointer("pointermove", 310, 210);
    expect(r.lit).toEqual([]);
  });

  it("clears a lit pick when the step ends", () => {
    const r = rig();
    r.begin();
    r.settle(12);
    r.under.hit = faceHit;
    r.pointer("pointermove", 310, 210);
    r.tool.cancel();
    expect(r.lit).toEqual([faceHit, null]);
  });

  it("adds the carry words to the prompt once the depth is set, not before, and never in an edit", () => {
    const r = rig();
    r.begin();
    r.depth(8);
    expect(prompts.filter((p) => p?.includes(carryWords.prompt()))).toEqual([]);
    r.settle(8);
    expect(prompts.at(-1)).toContain(carryWords.prompt());
    r.tool.cancel();
    const e = rig({ editing: true });
    prompts.length = 0;
    e.begin();
    e.settle(11);
    expect(prompts.filter((p) => p?.includes(carryWords.prompt()))).toEqual([]);
  });
});
