// Extrude shows every depth through the engine: the body is the real result, pushed once the pointer rests, flushed on
// a release, a typed value and a commit, and judged by the kernel's verdict. Nothing is drawn as a local prism or
// peeked through, and the press that commits keeps picking suspended until it is over.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createPinia, setActivePinia } from "pinia";
import { ExtrudeTool } from "../../src/features/extrudeTool";
import { SketchPlane } from "../../src/sketch/plane";
import { rectCorners } from "../../src/sketch/region";
import type { Viewport } from "../../src/viewport/viewport";
import type { DocumentStore } from "../../src/document/store";

interface Internals {
  distance: number;
  taper: number;
  grabbing: boolean;
  downPos: { x: number; y: number };
  updatePreview(): void;
  commit(): void;
}

function lenient<T>(own: Record<string, unknown>): T {
  return new Proxy(own, { get: (t, k) => (k in t ? t[k as string] : () => undefined) }) as unknown as T;
}

const plane = new SketchPlane({ origin: [10, -4, 7], normal: [0, 0.6, 0.8], xdir: [1, 0, 0] });
const inside = plane.to3D(2.5, 1.5);
const region = [inside.x, inside.y, inside.z];

const tools: ExtrudeTool[] = [];

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
  const picked: unknown[] = [wr];
  const overlay = {
    regions: [wr],
    update: vi.fn(),
    selectedRegions: () => picked,
    toggleRegionSelection: vi.fn(),
    selectRegionsByPoints: vi.fn(),
    setHoverRegion: vi.fn(),
    clearRegionSelection: () => {},
  };
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const setPeek = vi.fn(() => new Set());
  const viewport = lenient<Viewport>({
    suspendPicking: false,
    domElement: canvas,
    pixelWorldSize: () => 0.1,
    pointInSolid: () => false,
    setPeek,
  });
  const log: string[] = [];
  const calls = {
    setPreview: [] as unknown[][],
    setEditPreview: [] as unknown[][],
    beginEditPreview: [] as unknown[][],
    verify: [] as unknown[][],
    added: [] as unknown[],
    replaced: [] as unknown[],
  };
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
  const store = lenient<DocumentStore>({
    ...state,
    nextId: () => "f9",
    hiddenBodyIds: () => undefined,
    boundExpr: () => null,
    isParamBound: () => false,
    onBuild: () => () => {},
    onSessionBuild: () => () => {},
    setPreview: (...a: unknown[]) => {
      calls.setPreview.push(a);
      log.push(`preview:${(a[0] as { distance?: number } | null)?.distance ?? "none"}`);
    },
    setEditPreview: (...a: unknown[]) => void calls.setEditPreview.push(a),
    beginEditPreview: (...a: unknown[]) => void calls.beginEditPreview.push(a),
    endEditPreview: () => {},
    replaceFeature: (...a: unknown[]) => void calls.replaced.push(a),
    addFeature: (f: { distance: number }) => {
      calls.added.push(f);
      log.push(`add:${f.distance}`);
    },
    verifyCommit: (...a: unknown[]) => void calls.verify.push(a),
  });
  // The lenient proxy reads these live so a test can flip the kernel's answer.
  Object.defineProperties(store, {
    hasPreview: { get: () => state.hasPreview },
    previewError: { get: () => state.previewError },
    buildState: { get: () => state.buildState },
  });
  const tool = new ExtrudeTool(viewport, overlay as never, store);
  tools.push(tool);
  Object.assign(tool, { positionDim: () => {}, hitGizmo: () => false, hitTaper: () => false });
  const t = tool as unknown as Internals;
  const depth = (d: number) => {
    t.distance = d;
    t.updatePreview();
  };
  const begin = () => (opts.editing ? tool.startEdit("e1", vi.fn()) : tool.start(vi.fn()));
  return { tool, t, canvas, viewport, state, calls, log, setPeek, depth, begin };
}

const feat = (distance: number, more: Record<string, unknown> = {}) => ({
  id: "f9",
  type: "extrude",
  sketch: "f1",
  distance,
  operation: "new",
  regions: [region],
  ...more,
});

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  for (const tool of tools.splice(0)) if ((tool as unknown as { active: boolean }).active) tool.cancel();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("Extrude engine preview", () => {
  it("pushes the engine preview once per rest, held, not once per move", () => {
    const r = rig();
    r.begin();
    for (const d of [3, 4, 5]) {
      r.depth(d);
      vi.advanceTimersByTime(100);
    }
    expect(r.calls.setPreview).toEqual([]);
    vi.advanceTimersByTime(60);
    expect(r.calls.setPreview).toEqual([[feat(5), { hold: true }]]);
    r.depth(9);
    vi.advanceTimersByTime(150);
    expect(r.calls.setPreview).toEqual([
      [feat(5), { hold: true }],
      [feat(9), { hold: true }],
    ]);
  });

  it("asks nothing again for a repaint of the same depth", () => {
    const r = rig();
    r.begin();
    r.depth(5);
    vi.advanceTimersByTime(150);
    r.t.updatePreview();
    r.depth(5);
    vi.advanceTimersByTime(400);
    expect(r.calls.setPreview).toHaveLength(1);
  });

  it("previews a cut depth with the feature the commit writes", () => {
    const r = rig();
    r.begin();
    r.depth(-7.5);
    vi.advanceTimersByTime(150);
    r.t.commit();
    expect(r.calls.added).toEqual([feat(-7.5)]);
    expect(r.calls.setPreview[0]).toEqual([feat(-7.5), { hold: true }]);
  });

  it("drops the preview at zero depth and has nothing to drop when none was pushed", () => {
    const r = rig();
    r.begin();
    r.depth(0);
    vi.advanceTimersByTime(300);
    expect(r.calls.setPreview).toEqual([]);
    r.depth(5);
    vi.advanceTimersByTime(150);
    r.depth(0);
    vi.advanceTimersByTime(150);
    expect(r.calls.setPreview).toEqual([[feat(5), { hold: true }], [null]]);
  });

  it("flushes a typed value at once", () => {
    const r = rig();
    r.begin();
    const input = document.querySelector<HTMLInputElement>(".dim-input input")!;
    input.value = "7";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(r.calls.setPreview).toEqual([[feat(7), { hold: true }]]);
  });

  it("flushes the depth at once when the arrow is let go", () => {
    const r = rig();
    r.begin();
    r.t.grabbing = true;
    r.t.downPos = { x: 0, y: 0 };
    r.depth(12);
    expect(r.calls.setPreview).toEqual([]);
    r.canvas.dispatchEvent(new PointerEvent("pointerup", { clientX: 40, clientY: 40, button: 0, bubbles: true }));
    expect(r.calls.setPreview).toEqual([[feat(12), { hold: true }]]);
  });

  it("pushes what a commit is about to write first, then drops the preview, then writes", () => {
    const r = rig();
    r.begin();
    r.depth(6);
    r.t.commit();
    expect(r.log).toEqual(["preview:6", "preview:none", "add:6"]);
    vi.advanceTimersByTime(500);
    expect(r.log).toEqual(["preview:6", "preview:none", "add:6"]);
  });

  it("never peeks the model through, for a join, a cut or a commit", () => {
    const r = rig();
    r.begin();
    for (const d of [5, -5, 3]) {
      r.depth(d);
      vi.advanceTimersByTime(150);
    }
    r.t.commit();
    expect(r.setPeek).not.toHaveBeenCalled();
  });

  it("uses the edit preview for an edit, never a floating one", () => {
    const r = rig({ editing: true });
    r.begin();
    expect(r.calls.setEditPreview).toEqual([[expect.objectContaining({ id: "e1", distance: 6 }), { hold: true }]]);
    r.depth(11);
    vi.advanceTimersByTime(150);
    expect(r.calls.setEditPreview.at(-1)).toEqual([
      expect.objectContaining({ id: "e1", distance: 11, operation: "join" }),
      { hold: true },
    ]);
    r.depth(0);
    vi.advanceTimersByTime(150);
    expect(r.calls.beginEditPreview.at(-1)).toEqual(["e1"]);
    expect(r.calls.setPreview).toEqual([]);
  });

  describe("the kernel's verdict on a straight depth", () => {
    it("stays open with the reason when the preview was refused, commits nothing and drops nothing", () => {
      const r = rig();
      r.begin();
      r.depth(5);
      vi.advanceTimersByTime(150);
      r.state.hasPreview = true;
      r.state.previewError = "profile self intersects";
      r.t.commit();
      expect(r.tool.active).toBe(true);
      expect(r.calls.added).toEqual([]);
      expect(r.log).toEqual(["preview:5"]);
    });

    it("commits once the kernel is happy with the same depth", () => {
      const r = rig();
      r.begin();
      r.depth(5);
      vi.advanceTimersByTime(150);
      r.state.hasPreview = true;
      r.state.previewError = "profile self intersects";
      r.t.commit();
      r.state.previewError = null;
      r.t.commit();
      expect(r.calls.added).toEqual([feat(5)]);
      expect(r.calls.verify).toEqual([]);
      expect(r.tool.active).toBe(false);
    });

    it("commits at once while the preview is still building and has the commit verified", () => {
      const r = rig();
      r.begin();
      r.depth(5);
      r.state.hasPreview = true;
      r.state.buildState = { building: true, result: null };
      r.t.commit();
      expect(r.calls.added).toEqual([feat(5)]);
      expect(r.calls.verify).toEqual([["f9", "Extrude"]]);
    });
  });

  describe("the operation while the preview body is up", () => {
    it("stays New through a sign flip on an empty model, and guesses again for the next extrude", () => {
      const r = rig();
      r.begin();
      r.depth(5);
      vi.advanceTimersByTime(150);
      r.state.buildState = { building: false, result: { mesh: { positions: [1, 2, 3] } } };
      r.depth(-4);
      vi.advanceTimersByTime(150);
      expect(r.calls.setPreview.map((c) => (c[0] as { operation: string }).operation)).toEqual(["new", "new"]);
      r.tool.cancel();
      r.begin();
      r.depth(5);
      vi.advanceTimersByTime(150);
      expect((r.calls.setPreview.at(-1)![0] as { operation: string }).operation).toBe("join");
    });
  });

  describe("the press that commits", () => {
    const down = (c: HTMLElement) => c.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    const up = (c: HTMLElement, type = "pointerup") =>
      c.dispatchEvent(new PointerEvent(type, { button: 0, bubbles: true }));

    it("keeps picking suspended through its own pointerup, after the viewport's listener has run", () => {
      const r = rig();
      r.begin();
      r.depth(5);
      const seen: boolean[] = [];
      r.canvas.addEventListener("pointerup", () => seen.push(r.viewport.suspendPicking));
      down(r.canvas);
      expect(r.calls.added).toEqual([feat(5)]);
      expect(r.tool.active).toBe(false);
      expect(r.viewport.suspendPicking).toBe(true);
      up(r.canvas);
      expect(seen).toEqual([true]);
      expect(r.viewport.suspendPicking).toBe(false);
    });

    it("lets go of picking when the press is cancelled", () => {
      const r = rig();
      r.begin();
      r.depth(5);
      down(r.canvas);
      expect(r.viewport.suspendPicking).toBe(true);
      up(r.canvas, "pointercancel");
      expect(r.viewport.suspendPicking).toBe(false);
    });

    it("clears picking at once for a commit that no press made", () => {
      const r = rig();
      r.begin();
      r.depth(5);
      r.t.commit();
      expect(r.viewport.suspendPicking).toBe(false);
    });

    it("leaves picking to a tool started before the press ended", () => {
      const r = rig();
      r.begin();
      r.depth(5);
      down(r.canvas);
      r.begin();
      up(r.canvas);
      expect(r.tool.active).toBe(true);
      expect(r.viewport.suspendPicking).toBe(true);
    });

    it("leaves picking suspended after a refused press, as the open tool needs", () => {
      const r = rig();
      r.begin();
      r.depth(5);
      vi.advanceTimersByTime(150);
      r.state.hasPreview = true;
      r.state.previewError = "no";
      down(r.canvas);
      expect(r.tool.active).toBe(true);
      expect(r.viewport.suspendPicking).toBe(true);
      r.state.previewError = null;
      r.t.commit();
      expect(r.viewport.suspendPicking).toBe(false);
    });
  });
});
