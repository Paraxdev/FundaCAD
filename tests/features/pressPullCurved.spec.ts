// Press/pull on a sphere, a cone or a torus, faces the mesh fit cannot read:
// the engine's faceAxis answer decides what the arrow and the value box say.
// A sphere resizes about its centre as R or a diameter; a cone or a torus is
// offset along the normal where it was picked, with no taper, mode or up to.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { PressPullTool } from "../../src/features/pressPullTool";
import type { DocumentStore, RebuildState } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { Feature, Selector, Vec3 } from "../../src/types";
import type { FaceAxisReply, FaceResize } from "../../src/geometry/client";
import { usePromptStore } from "../../src/stores/prompt";

let frames: (() => void)[] = [];
const flushFrame = () => {
  const run = frames;
  frames = [];
  for (const f of run) f();
};

const PX = 10;
const FACE: Selector = { kind: "face", by: "nearest", point: [0, 0, 0] };

/** One face with its anchor at the origin. Its average normal is `average`,
 *  and the facet under the anchor faces `facet`. The pointer ray at (x, y)
 *  runs along +X at height z = y / 10, so a pixel is a tenth of a mm. */
function fakeViewport(average: Vec3, facet: Vec3) {
  const scene = new THREE.Scene();
  const canvas = document.createElement("canvas");
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, -500, 0);
  camera.lookAt(0, 0, 0);
  const n = new THREE.Vector3(...facet).normalize();
  const u = new THREE.Vector3(1, 0, 0).sub(n.clone().multiplyScalar(n.x)).normalize();
  const w = n.clone().cross(u);
  const tri = new THREE.Triangle(
    u.clone().multiplyScalar(-1).addScaledVector(w, -1),
    u.clone().addScaledVector(w, -1),
    w.clone().multiplyScalar(2),
  );
  const vp = {
    suspendPicking: false,
    domElement: canvas,
    camera,
    addToScene: (o: THREE.Object3D) => scene.add(o),
    removeFromScene: (o: THREE.Object3D) => scene.remove(o),
    requestRender: () => {},
    pixelWorldSize: () => 0.1,
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
      normal: new THREE.Vector3(...average).normalize(),
      anchor: new THREE.Vector3(0, 0, 0),
      bodyId: "b1",
      round: null,
    }),
    roundFaceAt: () => null,
    faceTriangles: () => [tri],
    faceIdNear: () => 7,
    faceIdToBodyId: () => "b1",
    setPeek: () => {},
    clearPressPullGhost: () => {},
    setPressPullGhost: vi.fn(),
    selectOnlyFace: () => {},
  };
  return { vp: vp as unknown as Viewport, canvas, ghost: vp.setPressPullGhost };
}

function fakeStore(reply: FaceAxisReply | null) {
  const listeners = new Set<(s: RebuildState) => void>();
  const previews: Feature[] = [];
  const added: Feature[] = [];
  const store = {
    nextId: () => "p1",
    setPreview(feature: Feature | null) {
      if (feature) previews.push(feature);
    },
    addFeature: (f: Feature) => added.push(f),
    verifyCommit: () => {},
    onBuild(fn: (s: RebuildState) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    faceAxis: async () => reply,
  };
  return { store: store as unknown as DocumentStore, previews, added };
}

function pointer(canvas: HTMLCanvasElement, type: string, y: number) {
  canvas.dispatchEvent(new PointerEvent(type, { clientX: 0, clientY: y, button: 0, bubbles: true }));
}

type ToolInternals = { value: number; axis: THREE.Vector3; anchor: THREE.Vector3; direction: string };
const internals = (t: PressPullTool) => t as unknown as ToolInternals;
const dirOf = (t: PressPullTool) => internals(t).axis.toArray().map((c) => Math.round(c * 1e9) / 1e9 + 0);

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
    direction: b?.querySelector<HTMLElement>(".dim-direction")?.style.display !== "none"
      ? b?.querySelector<HTMLElement>(".dim-direction")?.textContent ?? null
      : null,
  };
}

/** Grab the arrow a little way up its stalk and drag it until the value is `to`. */
function dragTo(t: PressPullTool, canvas: HTMLCanvasElement, to: number) {
  flushFrame();
  const i = internals(t);
  const dir = Math.sign(i.axis.z);
  const from = (i.anchor.z + i.axis.z * i.value + 0.5 * dir) * PX;
  const end = from + (to - i.value) * dir * PX;
  pointer(canvas, "pointerdown", from);
  pointer(canvas, "pointermove", end);
  vi.advanceTimersByTime(500);
  pointer(canvas, "pointerup", end);
  flushFrame();
}

const noTangent = { faces: 0, lostWhen: null, run: [[0, 0, 0]] as Vec3[], closed: false, followable: false };

function resize(r: Partial<FaceResize> & Pick<FaceResize, "kind" | "size" | "concave">): FaceResize {
  return { full: false, contact: null, tangent: noTangent, ...r };
}

async function started(average: Vec3, facet: Vec3, reply: FaceAxisReply) {
  const v = fakeViewport(average, facet);
  const s = fakeStore(reply);
  const t = new PressPullTool(v.vp, s.store);
  t.start(() => {});
  await Promise.resolve();
  await Promise.resolve();
  flushFrame();
  return { t, ...v, ...s };
}

const NO_AXIS = { reason: "the walls around the face do not all run along one axis" };

describe("press/pull on a sphere, a cone or a torus", () => {
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

  describe("a sphere dimple of radius 10 centred 10 above the face", () => {
    const ball = resize({ kind: "sphere", size: 10, concave: true, centre: [0, 0, 10] });
    const dimple: FaceAxisReply = { ...NO_AXIS, resize: ball };

    it("reads R from the engine and drags away from the centre", async () => {
      const { t, canvas, previews, ghost } = await started([0, 0, 1], [0, 0, 1], dimple);
      expect(box()).toMatchObject({ names: ["R"], value: "10", toggle: null });
      expect(dirOf(t)).toEqual([0, 0, -1]);
      dragTo(t, canvas, 1.5);
      expect(box().value).toBe("11.5");
      expect(previews.at(-1)).toMatchObject({ type: "press-pull", distance: -1.5, operation: "cut" });
      expect(previews.at(-1)).not.toHaveProperty("mode");
      expect(previews.at(-1)).not.toHaveProperty("taper");
      // The cap answers at once, grown about the centre, before the engine does.
      expect(ghost).toHaveBeenLastCalledWith([7], 1.5, expect.objectContaining({ centre: [0, 0, 10] }));
      expect(usePromptStore().text).toMatch(/type a radius/);
    });

    it("never offers to remove it, a sphere face reads as partial", async () => {
      const { t, canvas, previews } = await started([0, 0, 1], [0, 0, 1], dimple);
      dragTo(t, canvas, -9.5);
      expect(box().value).toBe("0.5");
      expect(previews.at(-1)).toMatchObject({ type: "press-pull", distance: 9.5 });
    });

    it("a ball end of a bore still starts down the bore, and resizes along the normal", async () => {
      const ballEnd: FaceAxisReply = { axis: { origin: [0, 0, 10], dir: [0, 0, 1] }, hole: true, resize: ball };
      const { t } = await started([0, 0, 1], [0, 0, 1], ballEnd);
      expect(internals(t).direction).toBe("axis");
      expect(box()).toMatchObject({ names: ["D"], toggle: "Auto", direction: "Along axis" });
      document.querySelector(".dim-direction")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      expect(box()).toMatchObject({ names: ["R"], toggle: null, direction: "Along normal" });
      expect(dirOf(t)).toEqual([0, 0, -1]);
    });
  });

  describe("a countersink cone, its average normal along the axis", () => {
    const cone = resize({ kind: "cone", size: 0, concave: true, full: true, axis: { origin: [0, 0, -5], dir: [0, 0, 1] } });
    const countersink: FaceAxisReply = { ...NO_AXIS, resize: cone };

    it("reads an offset along the facet picked, with no taper, mode or up to", async () => {
      const { t, canvas, previews, added, ghost } = await started([0, 1, 0], [0, 0, 1], countersink);
      expect(box()).toMatchObject({ names: ["Offset"], value: "0", toggle: null });
      expect(dirOf(t)).toEqual([0, 0, 1]);
      dragTo(t, canvas, -0.8);
      expect(box().value).toBe("-0.8");
      expect(ghost).toHaveBeenLastCalledWith([7], -0.8, "normal");
      expect(previews.at(-1)).toMatchObject({ type: "press-pull", distance: -0.8, operation: "cut" });
      expect(usePromptStore().text).toMatch(/how far it moves, negative cuts/);
      document.querySelector(".dim-input input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(added).toHaveLength(1);
      const f = added[0] as Record<string, unknown>;
      expect(f).toMatchObject({ type: "press-pull", distance: -0.8 });
      for (const k of ["mode", "taper", "upTo", "direction", "followTangent"]) expect(f).not.toHaveProperty(k);
    });

    it("the T key does not ask for a face to stop at", async () => {
      const { t } = await started([0, 1, 0], [0, 0, 1], countersink);
      t["onKey"](new KeyboardEvent("keydown", { key: "t" }));
      expect((t as unknown as { pickingTarget: boolean }).pickingTarget).toBe(false);
    });

    it("the cone floor of a blind hole starts down the hole, and offsets along the normal", async () => {
      const floor: FaceAxisReply = { axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, hole: true, resize: cone };
      const { t } = await started([0, 1, 0], [0, 0, 1], floor);
      expect(box()).toMatchObject({ names: ["D"], toggle: "Auto", direction: "Along axis" });
      document.querySelector(".dim-direction")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      expect(box()).toMatchObject({ names: ["Offset"], toggle: null, direction: "Along normal" });
      expect(dirOf(t)).toEqual([0, 0, 1]);
      document.querySelector(".dim-direction")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      expect(box()).toMatchObject({ names: ["D"], toggle: "Auto", direction: "Along axis" });
    });
  });

  it("a torus fillet reads an offset too, and grows out along its normal", async () => {
    const fillet: FaceAxisReply = {
      ...NO_AXIS,
      resize: resize({ kind: "torus", size: 2, concave: true, axis: { origin: [0, 0, 0], dir: [0, 0, 1] } }),
    };
    const { t, canvas, previews } = await started([0, 0, 1], [0, 0, 1], fillet);
    expect(box()).toMatchObject({ names: ["Offset"], toggle: null });
    dragTo(t, canvas, 0.5);
    expect(box().value).toBe("0.5");
    expect(previews.at(-1)).toMatchObject({ type: "press-pull", distance: 0.5, operation: "join" });
  });

  it("a flat face with no resize in the answer keeps its distance, angle and mode", async () => {
    await started([0, 0, 1], [0, 0, 1], { reason: "flat" });
    expect(box()).toMatchObject({ names: ["D", "Angle"], toggle: "Auto" });
  });

  describe("a cylinder of radius 3 above the face, its axis along X", () => {
    const hole = (full: boolean): FaceAxisReply =>
      ({ ...NO_AXIS, resize: resize({ kind: "cylinder", size: 3, concave: true, full, axis: { origin: [0, 0, 3], dir: [1, 0, 0] } }) });
    const prompt = () => usePromptStore().text ?? "";
    const type = (text: string) => {
      const input = document.querySelector<HTMLInputElement>(".dim-input input")!;
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };

    it("a partial arc reads R and is never offered for removal", async () => {
      const { t, canvas } = await started([0, 0, 1], [0, 0, 1], hole(false));
      expect(box().names).toEqual(["R"]);
      expect(prompt()).not.toMatch(/remove/);
      dragTo(t, canvas, -2.9);
      expect(prompt()).not.toMatch(/remove/);
    });

    it("a full wrap says where it goes, below the offset that removes it", async () => {
      await started([0, 0, 1], [0, 0, 1], hole(true));
      expect(box().names).toEqual(["Diameter"]);
      expect(prompt()).toMatch(/under ⌀0\.6 mm removes it/);
      type("+0.5");
      expect(prompt()).toMatch(/below -2\.7 mm removes it/);
      expect(prompt()).not.toMatch(/past/);
    });

    it("a refused typed radius never says release to remove", async () => {
      const { t, canvas } = await started([0, 0, 1], [0, 0, 1], hole(true));
      dragTo(t, canvas, -2.9);
      expect(prompt()).toMatch(/Release to remove this face/);
      type("r-2");
      expect(prompt()).not.toMatch(/remove/);
      expect(prompt()).toMatch(/A radius can't be negative · type another radius/);
      type("r");
      expect(prompt()).not.toMatch(/remove/);
    });
  });
});
