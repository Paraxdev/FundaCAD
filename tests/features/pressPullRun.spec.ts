// Press/pull on a whole slot picked face by face: when every face is in the
// first round face's tangent run, the selection reads that face's radius, as
// the lone face does; otherwise it is a signed push.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { PressPullTool } from "../../src/features/pressPullTool";
import type { DocumentStore, RebuildState } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { Feature, Selector, Vec3 } from "../../src/types";
import type { FaceAxisReply } from "../../src/geometry/client";
import type { RoundFace } from "../../src/features/radialDrag";

let frames: (() => void)[] = [];
const flushFrame = () => {
  const run = frames;
  frames = [];
  for (const f of run) f();
};

const PX = 10;
// The c1 upper slot along X: ends about y 7.125 and -7.125 at z 20, r 2,
// walls at z 18 and 22. Face 1 is the +Y end, the one picked first.
const RUN: Vec3[] = [[0, 9.125, 20], [0, 0, 22], [0, -9.125, 20], [0, 0, 18]];
const IDS = [1, 2, 3, 4];
const face = (p: Vec3): Selector => ({ kind: "face", by: "nearest", point: p });

const end: RoundFace = {
  cylinder: { axis: [1, 0, 0], point: [0, 7.125, 20], radius: 2 },
  radius: 2,
  solidInside: false,
  radial: new THREE.Vector3(0, 1, 0),
  full: false,
  tangent: null,
};

/** The pointer ray at (x, y) runs along +X at y = y / 10 through z 20, so
 *  dragging down the screen pulls the handle along +Y. */
function fakeViewport(selected: number[]) {
  const scene = new THREE.Scene();
  const canvas = document.createElement("canvas");
  const camera = new THREE.PerspectiveCamera();
  const tri = new THREE.Triangle(new THREE.Vector3(-25, 9.125, 20), new THREE.Vector3(25, 9.125, 20), new THREE.Vector3(0, 8.5, 21.9));
  const vp = {
    suspendPicking: false,
    domElement: canvas,
    camera,
    addToScene: (o: THREE.Object3D) => scene.add(o),
    removeFromScene: (o: THREE.Object3D) => scene.remove(o),
    requestRender: () => {},
    pixelWorldSize: () => 0.1,
    projectToScreen: (p: THREE.Vector3) => ({ x: p.x * PX, y: p.y * PX }),
    rayFrom: (_x: number, y: number) =>
      new THREE.Raycaster(new THREE.Vector3(-200, y / PX, 20), new THREE.Vector3(1, 0, 0)),
    probe: <T>(x: number, y: number, test: (rc: THREE.Raycaster) => T | null | undefined | false) => {
      scene.updateMatrixWorld();
      return test(vp.rayFrom(x, y)) || null;
    },
    snapStep: () => 0.05,
    clearHover: () => {},
    hoverFaceAt: () => null,
    pickFaceForPressPull: () => null,
    selectedFacesForPressPull: () => ({
      selectors: selected.map((id) => face(RUN[id - 1]!)),
      faceIds: selected,
      normal: new THREE.Vector3(0, -1, 0),
      anchor: new THREE.Vector3(0, 9.125, 20),
      bodyId: "b1",
      round: null,
      lead: end,
    }),
    roundFaceAt: () => null,
    faceTriangles: () => [tri],
    faceIdNear: (p: Vec3) => {
      const i = RUN.findIndex((q) => q.every((c, k) => Math.abs(c - p[k]!) < 1e-6));
      return i < 0 ? null : IDS[i]!;
    },
    faceIdToBodyId: () => "b1",
    setPeek: () => {},
    clearPressPullGhost: () => {},
    setPressPullGhost: vi.fn(),
    selectOnlyFace: () => {},
  };
  return { vp: vp as unknown as Viewport, canvas, ghost: vp.setPressPullGhost };
}

function fakeStore(reply: FaceAxisReply) {
  const previews: Feature[] = [];
  const store = {
    nextId: () => "p1",
    setPreview(feature: Feature | null) {
      if (feature) previews.push(feature);
    },
    addFeature: () => {},
    verifyCommit: () => {},
    onBuild: (_fn: (s: RebuildState) => void) => () => {},
    faceAxis: async () => reply,
  };
  return { store: store as unknown as DocumentStore, previews };
}

const slotEnd = (run: Vec3[]): FaceAxisReply => ({
  reason: "a slot end has no hole axis",
  resize: {
    kind: "cylinder", size: 2, full: false, concave: true,
    axis: { origin: [0, 7.125, 20], dir: [1, 0, 0] },
    contact: 2,
    tangent: { faces: 2, lostWhen: "shrink", run, closed: true, followable: true },
  },
});

function box() {
  const b = [...document.querySelectorAll<HTMLElement>(".dim-input")].find((x) => x.style.display !== "none");
  const names = [...(b?.querySelectorAll<HTMLElement>(".dim-field") ?? [])]
    .filter((f) => f.style.display !== "none")
    .map((f) => {
      const n = f.querySelector<HTMLElement>(".dim-name");
      return n ? n.title || n.textContent : null;
    });
  const toggle = b?.querySelector<HTMLElement>(".dim-toggle") ?? null;
  return {
    names,
    value: b?.querySelector("input")?.value ?? null,
    toggle: toggle && toggle.style.display !== "none" ? toggle.textContent : null,
  };
}

type ToolInternals = { value: number; axis: THREE.Vector3; anchor: THREE.Vector3 };

function dragTo(t: PressPullTool, canvas: HTMLCanvasElement, to: number) {
  flushFrame();
  const i = t as unknown as ToolInternals;
  const dir = Math.sign(i.axis.y);
  const from = (i.anchor.y + i.axis.y * i.value + 0.5 * dir) * PX;
  const end = from + (to - i.value) * dir * PX;
  const at = (type: string, y: number) =>
    canvas.dispatchEvent(new PointerEvent(type, { clientX: 0, clientY: y, button: 0, bubbles: true }));
  at("pointerdown", from);
  at("pointermove", end);
  vi.advanceTimersByTime(500);
  at("pointerup", end);
  flushFrame();
}

async function started(selected: number[], reply: FaceAxisReply) {
  const v = fakeViewport(selected);
  const s = fakeStore(reply);
  const t = new PressPullTool(v.vp, s.store);
  t.start(() => {});
  await Promise.resolve();
  await Promise.resolve();
  flushFrame();
  return { t, ...v, ...s };
}

describe("press/pull on a slot picked face by face", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    frames = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => { frames.push(fn); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("reads the whole run as the end's radius, with no follow switch", async () => {
    const { t, canvas, previews, ghost } = await started(IDS, slotEnd(RUN));
    expect(box()).toMatchObject({ names: ["R"], value: "2", toggle: null });
    expect((t as unknown as ToolInternals).axis.toArray().map((c) => c + 0)).toEqual([0, 1, 0]);
    dragTo(t, canvas, 0.5);
    expect(box().value).toBe("2.5");
    // Every face of the run moves along its own normal, not about the first end's axis.
    expect(ghost).toHaveBeenLastCalledWith(IDS, -0.5, "normal");
    const f = previews.at(-1) as Record<string, unknown>;
    expect(f).toMatchObject({ type: "press-pull", distance: -0.5, operation: "cut" });
    expect(f.face).toHaveLength(4);
    expect(f).not.toHaveProperty("followTangent");
  });

  it("pushes a selection reaching outside the run by a signed distance", async () => {
    const { t, canvas, previews } = await started(IDS, slotEnd(RUN.slice(0, 3)));
    expect(box()).toMatchObject({ names: ["D"], toggle: null });
    expect((t as unknown as ToolInternals).axis.toArray().map((c) => c + 0)).toEqual([0, -1, 0]);
    dragTo(t, canvas, 0.5);
    expect(previews.at(-1)).toMatchObject({ type: "press-pull", distance: 0.5 });
  });
});
