// Fillet continuity is a segmented control: one click or one key reaches any profile, and the pick is what the
// committed feature stores.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { CONTINUITY_SEGMENTS, EdgeFeatureTool } from "../../src/features/edgeFeatureTool";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";

function lenient<T extends object>(own: Record<string, unknown>): T {
  return new Proxy(own, {
    get: (t, k) => (k in t ? t[k as string] : () => undefined),
  }) as unknown as T;
}

const EDGE = { kind: "edge", by: "nearest", point: [0, 0, 0], body: "b1" };

function setup() {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, -100, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const vp = lenient<Viewport>({
    domElement: document.createElement("canvas"),
    camera,
    suspendPicking: false,
    selectedEdgeSelectors: () => [EDGE],
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

  it("offers one icon segment per profile, G1 chosen, and no G3 yet", () => {
    const segs = [...control().querySelectorAll<HTMLElement>(".dim-segment")];
    expect(segs.map((b) => b.dataset.id)).toEqual(["G1", "G2"]);
    expect(segs.map((b) => !!b.querySelector("svg.icon") && b.title.length > 0)).toEqual([true, true]);
    expect(chosen()).toEqual(["G1"]);
    expect(CONTINUITY_SEGMENTS.map((s) => s.key)).toEqual(["1", "2"]);
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

  it("keys 1 and 2 pick the profile while the tool runs", () => {
    input().blur();
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
});
