// A commit repaints only the bodies whose paint inputs changed, and what it leaves must equal a full pass.
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { BodyFinishLayer } from "../../src/viewport/bodyFinish";
import { DEFAULT_OVERLAYS } from "../../src/viewport/overlayKinds";
import { DisposeQueue } from "../../src/viewport/disposeQueue";
import { Highlighter } from "../../src/viewport/highlight";
import { ProgressiveModel } from "../../src/viewport/progressive";
import { disposeBody } from "../../src/viewport/render";
import type { BodyMesh } from "../../src/viewport/render";
import { Viewport } from "../../src/viewport/viewport";
import type { RebuildResult } from "../../src/types";

interface Spec {
  id: string;
  faces: number;
  etag: string;
}

/** Each body is a strip of `faces` slanted triangles, one face per triangle, away from the origin. */
function reply(specs: Spec[]): RebuildResult {
  const positions: number[] = [];
  const indices: number[] = [];
  const faceIds: number[] = [];
  const bodies: NonNullable<RebuildResult["bodies"]> = [];
  let faceStart = 0;
  specs.forEach((s, b) => {
    for (let f = 0; f < s.faces; f++) {
      const v = positions.length / 3;
      positions.push(3 + b * 5 + f, 7 + f * 0.5, 2 + b, 4 + b * 5 + f, 7.5 + f, 2.5 + b, 3.5 + b * 5 + f, 9 + f, 3 + b);
      indices.push(v, v + 1, v + 2);
      faceIds.push(faceStart + f);
    }
    bodies.push({ id: s.id, name: s.id, faceStart, faceCount: s.faces, etag: s.etag });
    faceStart += s.faces;
  });
  return {
    mesh: { positions, indices, faceIds },
    edges: [],
    bbox: { min: [3, 7, 2], max: [40, 30, 10] },
    bodies,
  };
}

interface Bare {
  model: { bodies: BodyMesh[] } | null;
  finish: BodyFinishLayer;
  highlighter: Highlighter | null;
}
const V = (b: Bare) => b as unknown as Viewport;

function bare(): Bare {
  const group = new THREE.Group();
  const vp = Object.create(Viewport.prototype) as Bare;
  const noop = () => {};
  Object.assign(vp, {
    scene: {
      modelGroup: group,
      scene: new THREE.Scene(),
      frameShadows: noop,
      renderer: { shadowMap: { enabled: false } },
    },
    progressive: new ProgressiveModel(group, disposeBody),
    resolution: new THREE.Vector2(800, 600),
    model: null,
    streaming: false,
    streamMemo: null,
    lastResult: null,
    highlighter: null,
    xray: false,
    stale: false,
    wireframe: false,
    peek: new Set<string>(),
    analysis: "none",
    faceBands: new Map(),
    savedMats: new Map(),
    caps: new Map(),
    syncBloomable: noop,
    auditScene: noop,
    requestRender: noop,
    bodyBoxes: () => [],
    picker: { invalidate: noop },
    rig: { setContentBox: noop, fit: noop },
    overlays: DEFAULT_OVERLAYS,
    disposeQueue: new DisposeQueue((run) => run()),
    ghostMeshes: [],
    combsObj: null,
    zebra: false,
    combs: false,
    section: null,
    applyBodyFinish: noop,
    setInterferenceOverlay: noop,
    setStressOverlay: noop,
    clearFaceMarks: noop,
    setComMarker: noop,
    dropAreaProjection: noop,
  });
  vp.finish = new BodyFinishLayer({
    model: () => vp.model as never,
    scene: () => ({}) as never,
    faceIdToBodyId: () => null,
    addToScene: noop,
    requestRender: noop,
    savedMats: () => new Map(),
  });
  return vp;
}

/** The colour buffer and the base colours of every body, which is the whole look a repaint decides. */
const look = (vp: Bare) =>
  vp.model!.bodies.map((b) => {
    const attr = b.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    return { id: b.id, live: Array.from(attr.array), base: Array.from(b.baseColors) };
  });

const PAINT = { b: "#c0392b", c: "#2e86c1" };
const specs = (over: Partial<Record<string, Partial<Spec>>> = {}): Spec[] =>
  [
    { id: "a", faces: 3, etag: "a1" },
    { id: "b", faces: 2, etag: "b1" },
    { id: "c", faces: 4, etag: "c1" },
    { id: "d", faces: 3, etag: "d1" },
  ].map((s) => ({ ...s, ...over[s.id] }));

const commit = (vp: Bare, r: RebuildResult) => V(vp).setModel(r);

/** What a viewport that has never seen the model paints, the full pass to compare against. */
function fullPass(r: RebuildResult, bodyPaint: Record<string, string>, facePaint: Record<number, string>) {
  const fresh = bare();
  fresh.finish.bodyPaint = bodyPaint;
  fresh.finish.facePaint = facePaint;
  commit(fresh, r);
  return look(fresh);
}

const paintedBodies = (spy: { mock: { calls: unknown[][] } }): string[][] =>
  spy.mock.calls.map((c) => [...((c[1] as Iterable<BodyMesh> | undefined) ?? [])].map((b) => b.id));

describe("a commit repaints only what changed", () => {
  const facePaint = { 0: "#27ae60", 6: "#f39c12", 9: "#8e44ad" } as Record<number, string>;

  it("one replaced body leaves every body as a full pass paints it", () => {
    const vp = bare();
    vp.finish.bodyPaint = PAINT;
    vp.finish.facePaint = facePaint;
    commit(vp, reply(specs()));
    const spy = vi.spyOn(Highlighter.prototype, "setBase");
    const next = reply(specs({ c: { etag: "c2" } }));
    commit(vp, next);
    expect(paintedBodies(spy)).toEqual([["c"]]);
    spy.mockRestore();
    expect(look(vp)).toEqual(fullPass(next, PAINT, facePaint));
  });

  it("repaints nothing when no body changed", () => {
    const vp = bare();
    vp.finish.bodyPaint = PAINT;
    commit(vp, reply(specs()));
    const spy = vi.spyOn(Highlighter.prototype, "setBase");
    commit(vp, reply(specs()));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(look(vp)).toEqual(fullPass(reply(specs()), PAINT, {}));
  });

  it("a face id shift recolours the body whose painted face moved and keeps the rest", () => {
    const vp = bare();
    vp.finish.bodyPaint = PAINT;
    vp.finish.facePaint = facePaint;
    commit(vp, reply(specs()));
    // b grows by two faces, so c moves from 5 to 7 and d from 9 to 11 while global faces 6 and 9 stay painted.
    const spy = vi.spyOn(Highlighter.prototype, "setBase");
    const next = reply(specs({ b: { faces: 4, etag: "b2" } }));
    commit(vp, next);
    const painted = paintedBodies(spy).flat();
    spy.mockRestore();
    expect(painted).toContain("b");
    expect(painted).toContain("c");
    expect(painted).not.toContain("a");
    expect(look(vp)).toEqual(fullPass(next, PAINT, facePaint));
  });

  it("a shift that leaves a body's look alone does not repaint it", () => {
    const vp = bare();
    vp.finish.bodyPaint = PAINT;
    commit(vp, reply(specs()));
    const spy = vi.spyOn(Highlighter.prototype, "setBase");
    commit(vp, reply(specs({ a: { faces: 5, etag: "a2" } })));
    expect(paintedBodies(spy)).toEqual([["a"]]);
    spy.mockRestore();
  });

  it("a preview and its clear restore exactly the look before the preview", () => {
    const vp = bare();
    vp.finish.bodyPaint = PAINT;
    vp.finish.facePaint = facePaint;
    const base = reply(specs());
    commit(vp, base);
    const before = look(vp);
    commit(vp, reply(specs({ b: { faces: 3, etag: "bp" }, c: { etag: "cp" } })));
    expect(look(vp)).not.toEqual(before);
    commit(vp, reply(specs()));
    expect(look(vp)).toEqual(before);
    expect(look(vp)).toEqual(fullPass(base, PAINT, facePaint));
  });

  it("a hover tint left on a kept body is gone after the commit", () => {
    const vp = bare();
    vp.finish.bodyPaint = PAINT;
    commit(vp, reply(specs()));
    vp.highlighter!.hoverFaceRun([6, 7]);
    const next = reply(specs({ a: { etag: "a2" } }));
    commit(vp, next);
    expect(look(vp)).toEqual(fullPass(next, PAINT, {}));
  });

  it("a paint change on a kept body repaints that body only", () => {
    const vp = bare();
    vp.finish.bodyPaint = PAINT;
    const r = reply(specs());
    commit(vp, r);
    const spy = vi.spyOn(Highlighter.prototype, "setBase");
    const next = { ...PAINT, d: "#16a085" };
    V(vp).setBodyPaint(next);
    expect(paintedBodies(spy)).toEqual([["d"]]);
    spy.mockRestore();
    expect(look(vp)).toEqual(fullPass(r, next, {}));
  });

  it("the second document leaves nothing of the first", () => {
    const vp = bare();
    vp.finish.bodyPaint = PAINT;
    vp.finish.facePaint = facePaint;
    commit(vp, reply(specs()));
    vp.finish.bodyPaint = { x: "#d35400" };
    vp.finish.facePaint = { 1: "#1abc9c" };
    const other = reply([
      { id: "x", faces: 2, etag: "x1" },
      { id: "a", faces: 3, etag: "a1" },
    ]);
    commit(vp, other);
    expect(look(vp)).toEqual(fullPass(other, { x: "#d35400" }, { 1: "#1abc9c" }));
  });
});
