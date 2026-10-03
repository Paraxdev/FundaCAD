// Offset Face as the user drives it: the drag, the engine's answer for each
// value it previews, and what a release or Enter then commits. The store is a
// fake that replies the way DocumentStore settles a held preview, so a
// refusal arrives as heldRefusal with the last model that built kept.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { FaceOffsetTool } from "../../src/features/faceOffsetTool";
import type { DocumentStore, RebuildState } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { Feature, Selector } from "../../src/types";
import type { RoundFace } from "../../src/features/radialDrag";
import type { FaceAxisReply } from "../../src/geometry/client";
import { usePromptStore } from "../../src/stores/prompt";

let frames: (() => void)[] = [];
const flushFrame = () => {
  const run = frames;
  frames = [];
  for (const f of run) f();
};

const PX = 10;
const FACE: Selector = { kind: "face", by: "nearest", point: [0, 0, 0] };

/** Every face here faces +Z with its anchor at the origin. The pointer ray at
 *  (x, y) runs along +X at height z = y / 10, so a pixel is a tenth of a mm. */
function fakeViewport(opts: { round?: RoundFace | null; thickness?: number | null } = {}) {
  const scene = new THREE.Scene();
  const canvas = document.createElement("canvas");
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, -500, 0);
  camera.lookAt(0, 0, 0);
  const round = opts.round ?? null;
  const vp = {
    suspendPicking: false,
    domElement: canvas,
    camera,
    addToScene: (o: THREE.Object3D) => scene.add(o),
    removeFromScene: (o: THREE.Object3D) => scene.remove(o),
    requestRender: () => {},
    pixelWorldSize: () => 0.1,
    modelDiagonal: () => 100,
    projectToScreen: (p: THREE.Vector3) => ({ x: p.x * PX, y: p.z * PX }),
    rayFrom: (_x: number, y: number) =>
      new THREE.Raycaster(new THREE.Vector3(-200, 0, y / PX), new THREE.Vector3(1, 0, 0)),
    probe: <T>(x: number, y: number, test: (rc: THREE.Raycaster) => T | null | undefined | false) =>
      test(vp.rayFrom(x, y)) || null,
    snapStep: () => 0.05,
    clearHover: () => {},
    hoverFaceAt: () => null,
    pickFaceForPressPull: () => null,
    selectedFacesForPressPull: () => ({
      selectors: [FACE],
      faceIds: [7],
      normal: new THREE.Vector3(0, 0, round ? -1 : 1),
      anchor: new THREE.Vector3(0, 0, 0),
      bodyId: "b1",
      round,
    }),
    roundFaceAt: () => round,
    thicknessBehind: () => opts.thickness ?? null,
    faceTriangles: () => [],
    faceIdNear: () => 7,
  };
  return { vp: vp as unknown as Viewport, scene, canvas };
}

function fakeStore(axisReply: FaceAxisReply | null = null) {
  const listeners = new Set<(s: RebuildState) => void>();
  const previews: { feature: Feature | null; hold: boolean }[] = [];
  const added: Feature[] = [];
  const verified: string[] = [];
  const state = {
    hasPreview: false,
    previewError: null as string | null,
    buildState: { building: false } as RebuildState,
  };
  const store = {
    nextId: () => "p1",
    setPreview(feature: Feature | null, o?: { hold?: boolean }) {
      previews.push({ feature, hold: !!o?.hold });
      state.hasPreview = feature !== null;
    },
    addFeature: (f: Feature) => added.push(f),
    verifyCommit: (id: string) => verified.push(id),
    onBuild(fn: (s: RebuildState) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    faceAxis: async () => axisReply,
    get hasPreview() { return state.hasPreview; },
    get previewError() { return state.previewError; },
    get buildState() { return state.buildState; },
  };
  /** The kernel answers the last preview sent: it built, or it was refused and
   *  the model before it is held on screen. */
  const answer = (refusal?: string) => {
    const sent = previews.at(-1)?.feature ?? null;
    const s = {
      building: false,
      result: {},
      previewBuilt: sent ? [sent] : null,
      heldRefusal: refusal && sent ? { featureId: sent.id, message: refusal, code: "resizeInvalid", diagnostics: [] } : null,
      errorFeatureId: refusal && sent ? sent.id : null,
      errorMessage: refusal ?? null,
    } as unknown as RebuildState;
    state.buildState = s;
    state.previewError = refusal ?? null;
    for (const fn of [...listeners]) fn(s);
  };
  return { store: store as unknown as DocumentStore, previews, added, verified, answer };
}

function pointer(canvas: HTMLCanvasElement, type: string, y: number) {
  canvas.dispatchEvent(new PointerEvent(type, { clientX: 0, clientY: y, button: 0, bubbles: true }));
}

type ToolInternals = {
  value: number;
  gizmo: THREE.Group | null;
  axis: THREE.Vector3;
  anchor: THREE.Vector3;
};
const internals = (t: FaceOffsetTool) => t as unknown as ToolInternals;

function field() {
  const box = [...document.querySelectorAll<HTMLElement>(".dim-input")].find((b) => b.style.display !== "none");
  const name = box?.querySelector<HTMLElement>(".dim-name");
  return {
    label: name ? name.title || name.textContent : null,
    value: box?.querySelector("input")?.value ?? null,
    input: box?.querySelector("input") ?? null,
    problem: box?.querySelector(".dim-problem")?.textContent ?? null,
    toggle: box?.querySelector<HTMLElement>(".dim-toggle") ?? null,
  };
}

/** Grab the arrow a little way up its stalk and drag it until the value is
 *  `to` mm, letting the debounced preview go out. Returns the release. */
function dragTo(t: FaceOffsetTool, canvas: HTMLCanvasElement, to: number, { release = true } = {}) {
  flushFrame();
  const i = internals(t);
  const dir = Math.sign(i.axis.z || 1);
  const from = (i.anchor.z + i.axis.z * i.value + 0.5 * dir) * PX;
  const end = from + (to - i.value) * dir * PX;
  pointer(canvas, "pointerdown", from);
  pointer(canvas, "pointermove", end);
  vi.advanceTimersByTime(500);
  const up = () => pointer(canvas, "pointerup", end);
  if (release) up();
  return up;
}

describe("FaceOffsetTool", () => {
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

  it("holds the last offset that built while the kernel refuses a bigger one", () => {
    const { vp, canvas } = fakeViewport();
    const s = fakeStore();
    const t = new FaceOffsetTool(vp, s.store);
    t.start("offsetFace", () => {});
    dragTo(t, canvas, 2, { release: false });
    const sent = s.previews.filter((p) => p.feature);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((p) => p.hold)).toBe(true);
  });

  it("a release the kernel refuses commits the offset shown on screen", () => {
    const { vp, canvas } = fakeViewport();
    const s = fakeStore();
    const t = new FaceOffsetTool(vp, s.store);
    let done: string | null | undefined;
    t.start("offsetFace", (id) => { done = id; });
    const up = dragTo(t, canvas, 1, { release: false });
    s.answer();
    up();
    expect(s.added).toHaveLength(1);
    expect(s.added[0]).toMatchObject({ type: "offsetFace", distance: 1 });
    expect(done).toBe("p1");

    const t2 = new FaceOffsetTool(vp, s.store);
    t2.start("offsetFace", () => {});
    dragTo(t2, canvas, 1, { release: false });
    s.answer();
    flushFrame();
    const up2 = dragTo(t2, canvas, 3, { release: false });
    s.answer("Offset face: can't change this face to that size, the result wouldn't be a valid solid");
    flushFrame();
    expect(field().problem).toBe("can't change this face to that size, the result wouldn't be a valid solid");
    expect(usePromptStore().text).toMatch(/keeping 1/);
    up2();
    expect(s.added).toHaveLength(2);
    expect(s.added[1]).toMatchObject({ type: "offsetFace", distance: 1 });
  });

  it("a drag out and back that ends beside where it began still commits", () => {
    const { vp, canvas } = fakeViewport();
    const s = fakeStore();
    const t = new FaceOffsetTool(vp, s.store);
    t.start("offsetFace", () => {});
    flushFrame();
    const from = 0.5 * PX;
    pointer(canvas, "pointerdown", from);
    pointer(canvas, "pointermove", from + 1 * PX);
    vi.advanceTimersByTime(500);
    s.answer();
    pointer(canvas, "pointermove", from + 2);
    vi.advanceTimersByTime(500);
    s.answer("Offset face: no");
    pointer(canvas, "pointerup", from + 2);
    expect(s.added).toHaveLength(1);
    expect(s.added[0]).toMatchObject({ distance: 1 });
  });

  it("a refused typed value stays open rather than committing another number", () => {
    const { vp } = fakeViewport();
    const s = fakeStore();
    const t = new FaceOffsetTool(vp, s.store);
    t.start("offsetFace", () => {});
    const f = field();
    f.input!.value = "4";
    f.input!.dispatchEvent(new Event("input"));
    flushFrame();
    vi.advanceTimersByTime(500);
    s.answer("Offset face: no");
    f.input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(s.added).toHaveLength(0);
    expect(t.active).toBe(true);
  });

  it("the handle rides on the face as it moves", () => {
    const { vp, canvas } = fakeViewport();
    const s = fakeStore();
    const t = new FaceOffsetTool(vp, s.store);
    t.start("offsetFace", () => {});
    dragTo(t, canvas, 2, { release: false });
    flushFrame();
    expect(internals(t).gizmo!.position.z).toBeCloseTo(2, 6);
  });

  describe("on a slot end, a half bore of radius 2", () => {
    const slotEnd = (): RoundFace => ({
      cylinder: { point: [0, 0, -2], axis: [1, 0, 0], radius: 2 } as RoundFace["cylinder"],
      radius: 2,
      solidInside: false,
      radial: new THREE.Vector3(0, 0, 1),
      full: false,
      tangent: null,
    });
    const reply: FaceAxisReply = {
      reason: "not an end",
      resize: {
        kind: "cylinder", size: 2, full: false, concave: true, contact: 2,
        axis: { origin: [0, 0, -2], dir: [1, 0, 0] },
        tangent: { faces: 2, lostWhen: "shrink", run: [[0, 0, 0], [5, 0, 0]], closed: true, followable: true },
      },
    };

    it("reads its radius and scrubs it along the radial arrow", () => {
      const { vp, canvas } = fakeViewport({ round: slotEnd(), thickness: 10 });
      const s = fakeStore();
      const t = new FaceOffsetTool(vp, s.store);
      t.start("offsetFace", () => {});
      expect(field().label).toBe("R");
      expect(Number(field().value)).toBeCloseTo(2, 6);
      expect(internals(t).axis.z).toBeCloseTo(1, 6);
      dragTo(t, canvas, 0.5, { release: false });
      expect(Number(field().value)).toBeCloseTo(2.5, 6);
      expect(s.previews.at(-1)?.feature).toMatchObject({ type: "offsetFace", distance: -0.5 });
      flushFrame();
      expect(internals(t).gizmo!.position.z).toBeCloseTo(0.5, 6);
    });

    it("a typed radius is absolute, and a negative one is said in the box", () => {
      const { vp } = fakeViewport({ round: slotEnd() });
      const s = fakeStore();
      const t = new FaceOffsetTool(vp, s.store);
      t.start("offsetFace", () => {});
      const f = field();
      f.input!.value = "1.5";
      f.input!.dispatchEvent(new Event("input"));
      flushFrame();
      vi.advanceTimersByTime(500);
      expect(s.previews.at(-1)?.feature).toMatchObject({ distance: 0.5 });
      f.input!.value = "-1";
      f.input!.dispatchEvent(new Event("input"));
      expect(field().problem).toBe("a radius can't be negative");
    });

    it("offers Tangent faces follow once the engine names the walls, and writes it", async () => {
      const { vp, canvas } = fakeViewport({ round: slotEnd() });
      const s = fakeStore(reply);
      const t = new FaceOffsetTool(vp, s.store);
      t.start("offsetFace", () => {});
      await Promise.resolve();
      await Promise.resolve();
      const toggle = field().toggle;
      expect(toggle?.textContent).toBe("Tangent faces follow");
      expect(toggle?.style.display).not.toBe("none");
      dragTo(t, canvas, -0.5, { release: false });
      expect(s.previews.at(-1)?.feature).toMatchObject({ distance: 0.5, followTangent: true });
    });

    it("a full bore reads its diameter", () => {
      const { vp } = fakeViewport({ round: { ...slotEnd(), full: true } });
      const s = fakeStore();
      const t = new FaceOffsetTool(vp, s.store);
      t.start("offsetFace", () => {});
      expect(field().label).toBe("Diameter");
      expect(Number(field().value)).toBeCloseTo(4, 6);
    });
  });
});
