// Fillet continuity is a segmented control: one click or one key reaches any profile, and the pick is what the
// committed feature stores.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { CONTINUITY_SEGMENTS, EdgeFeatureTool } from "../../src/features/edgeFeatureTool";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import { usePromptStore } from "../../src/stores/prompt";

function lenient<T extends object>(own: Record<string, unknown>): T {
  return new Proxy(own, {
    get: (t, k) => (k in t ? t[k as string] : () => undefined),
  }) as unknown as T;
}

const EDGE = { kind: "edge", by: "nearest", point: [0, 0, 0], body: "b1" };

/** One picked edge per curvature, the engine's `curvature` across each, per mm of radius and of chord (absent when
 *  flat). */
function setup(curvatures: number[] = []) {
  const picks = curvatures.map((_, i) => ({ ...EDGE, point: [i * 10, 0, 0] }));
  const lines = curvatures.map((k, i) => ({
    id: `e${i}`,
    body: "b1",
    points: [
      [i * 10, -1, 0],
      [i * 10, 1, 0],
    ],
    smooth: false,
    ...(k ? { curvature: [k, k] } : {}),
  }));
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, -100, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const vp = lenient<Viewport>({
    domElement: document.createElement("canvas"),
    camera,
    suspendPicking: false,
    selectedEdgeSelectors: () => (picks.length ? picks : [EDGE]),
    edgeLineForSelector: (p: number[]) => lines.find((l) => l.points[0]![0] === p[0]) ?? null,
    selectedEdgeScope: () => ({ scope: "single" }),
    pixelWorldSize: () => 0.1,
    projectToScreen: () => ({ x: 100, y: 100 }),
    modelDiagonal: () => 100,
    edgeLineByMid: () => null,
    visibleEdgeLines: () => [],
    rayFrom: () => new THREE.Raycaster(new THREE.Vector3(0, -100, 0), new THREE.Vector3(0, 1, 0)),
  });
  let n = 0;
  const added: unknown[] = [];
  const store = lenient<DocumentStore>({
    document: { features: [], parameters: {} },
    nextId: () => `f${++n}`,
    onBuild: () => () => {},
    isParamBound: () => false,
    bareParamRef: () => null,
    addFeature: (f: unknown) => added.push(f),
  });
  const tool = new EdgeFeatureTool(vp, store);
  tool.start("fillet", () => {});
  return { tool, added };
}

/** Edits a stored fillet on one edge that curves across at `curvature` per mm of radius and of chord, once the
 *  rollback build lands. */
function setupEdit(fillet: Record<string, unknown>, curvature: [number, number]) {
  const line = {
    id: "e0",
    body: "b1",
    points: [
      [0, -1, 0],
      [0, 1, 0],
    ],
    smooth: false,
    curvature,
  };
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, -100, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const vp = lenient<Viewport>({
    domElement: document.createElement("canvas"),
    camera,
    suspendPicking: false,
    edgeLineForSelector: () => line,
    pixelWorldSize: () => 0.1,
    projectToScreen: () => ({ x: 100, y: 100 }),
    modelDiagonal: () => 100,
    edgeLineByMid: () => null,
    visibleEdgeLines: () => [],
    rayFrom: () => new THREE.Raycaster(new THREE.Vector3(0, -100, 0), new THREE.Vector3(0, 1, 0)),
  });
  const feature = { id: "f1", type: "fillet", edges: EDGE, ...fillet };
  const added: unknown[] = [];
  let landed: ((s: unknown) => void) | null = null;
  const store = lenient<DocumentStore>({
    document: { features: [feature], parameters: {} },
    onBuild: (cb: (s: unknown) => void) => {
      landed = cb;
      return () => {};
    },
    isParamBound: () => false,
    bareParamRef: () => null,
  });
  const tool = new EdgeFeatureTool(vp, store);
  expect(tool.startEdit("f1", () => {})).toBe(true);
  landed!({ building: false, result: { bbox: { min: [0, 0, 0], max: [1, 1, 1] } }, previewBuilt: [] });
  return { tool, added };
}

const input = () => document.querySelector<HTMLInputElement>(".dim-input input")!;
const control = () => document.querySelector<HTMLElement>('.dim-seg[data-option="continuity"]')!;
const segment = (id: string) => control().querySelector<HTMLElement>(`.dim-segment[data-id="${id}"]`)!;
const chosen = () => [...control().querySelectorAll<HTMLElement>(".dim-segment.on")].map((b) => b.dataset.id);
const click = (el: Element) => el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
const key = (target: EventTarget, k: string, alt = false) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: `Digit${k}`, altKey: alt, bubbles: true }));
function type(text: string) {
  input().focus();
  input().value = text;
  input().dispatchEvent(new Event("input", { bubbles: true }));
}
const enter = () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

describe("fillet continuity control", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    t = setup();
  });
  afterEach(() => {
    t.tool.cancel();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("offers one icon segment per profile, G1 chosen", () => {
    const segs = [...control().querySelectorAll<HTMLElement>(".dim-segment")];
    expect(segs.map((b) => b.dataset.id)).toEqual(["G1", "G2", "G3"]);
    expect(segs.map((b) => !!b.querySelector("svg.icon") && b.title.length > 0)).toEqual([true, true, true]);
    expect(chosen()).toEqual(["G1"]);
    expect(CONTINUITY_SEGMENTS.map((s) => s.key)).toEqual(["1", "2", "3"]);
  });

  it("a click sets each value, and the stored feature carries it", () => {
    click(segment("G2"));
    expect(chosen()).toEqual(["G2"]);
    click(segment("G1"));
    expect(chosen()).toEqual(["G1"]);
    click(segment("G2"));
    type("2");
    enter();
    expect(t.added).toEqual([{ id: "f1", type: "fillet", radius: 2, edges: EDGE, continuity: "G2" }]);
  });

  it("G1 stores no continuity field", () => {
    click(segment("G2"));
    click(segment("G1"));
    type("3");
    enter();
    expect(t.added).toEqual([{ id: "f1", type: "fillet", radius: 3, edges: EDGE }]);
  });

  it("keys 1, 2 and 3 pick the profile while the tool runs", () => {
    input().blur();
    key(document.body, "3");
    expect(chosen()).toEqual(["G3"]);
    key(document.body, "2");
    expect(chosen()).toEqual(["G2"]);
    key(document.body, "1");
    expect(chosen()).toEqual(["G1"]);
    key(document.body, "2");
    type("1.5");
    enter();
    expect(t.added).toEqual([{ id: "f1", type: "fillet", radius: 1.5, edges: EDGE, continuity: "G2" }]);
  });

  it("in the radius field a bare digit stays a digit, Alt with it picks the profile", () => {
    input().focus();
    key(input(), "2");
    expect(chosen()).toEqual(["G1"]);
    key(input(), "2", true);
    expect(chosen()).toEqual(["G2"]);
  });

  describe("on an edge along a curved face", () => {
    it("a mixed pick greys G2 and G3 with the reason, and their keys say why instead of picking", () => {
      t.tool.cancel();
      document.body.innerHTML = "";
      t = setup([0, 1 / 15]);
      for (const id of ["G2", "G3"]) {
        expect(segment(id).classList.contains("disabled")).toBe(true);
        expect(segment(id).getAttribute("aria-disabled")).toBe("true");
        expect(segment(id).title).toMatch(/needs both faces flat across the edge/);
      }
      expect(segment("G1").classList.contains("disabled")).toBe(false);
      input().blur();
      key(document.body, "3");
      expect(chosen()).toEqual(["G1"]);
      expect(usePromptStore().text).toMatch(/^G3 needs both faces flat across the edge/);
    });

    it("a chord sized fillet weighs the curvature per mm of chord, which a shallow edge makes larger", () => {
      t.tool.cancel();
      document.body.innerHTML = "";
      t = setupEdit({ radius: 50 }, [1e-8, 5e-8]);
      expect(segment("G2").classList.contains("disabled")).toBe(false);
      t.tool.cancel();
      document.body.innerHTML = "";
      t = setupEdit({ radius: 50, sizeType: "chord" }, [1e-8, 5e-8]);
      expect(segment("G2").classList.contains("disabled")).toBe(true);
      expect(segment("G3").classList.contains("disabled")).toBe(true);
    });

    it("a radius that makes the curve count drops a chosen G3 back to G1", () => {
      t.tool.cancel();
      document.body.innerHTML = "";
      t = setup([1e-7]);
      input().blur();
      key(document.body, "3");
      expect(chosen()).toEqual(["G3"]);
      type("20");
      enter();
      expect(t.added).toEqual([{ id: "f1", type: "fillet", radius: 20, edges: { ...EDGE, point: [0, 0, 0] } }]);
    });
  });
});
