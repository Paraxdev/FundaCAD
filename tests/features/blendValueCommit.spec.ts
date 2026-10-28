// A value typed into the fillet box is what confirm and Enter commit, with no blur, pointer move or frame between;
// text that is no radius keeps the last valid one, marks the box, and is what confirm commits.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { EdgeFeatureTool } from "../../src/features/edgeFeatureTool";
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
    selectedEdgeSeeds: () => [{ sel: EDGE }],
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
const isBad = () => document.querySelector(".dim-input")!.classList.contains("dim-bad");

function type(text: string) {
  input().focus();
  input().value = text;
  input().dispatchEvent(new Event("input", { bubbles: true }));
}
const enter = () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
const confirmButton = () =>
  document.querySelector(".dim-ok")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));

describe("fillet radius box", () => {
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

  const fillet = (radius: number) => [{ id: "f1", type: "fillet", radius, edges: EDGE }];

  it("type then confirm, with no blur, commits the typed radius", () => {
    type("2.5");
    confirmButton();
    expect(t.added).toEqual(fillet(2.5));
  });

  it("type then Enter commits the typed radius", () => {
    type("3.75");
    enter();
    expect(t.added).toEqual(fillet(3.75));
  });

  it("a radius just over 0 is taken", () => {
    type("0.25");
    expect(isBad()).toBe(false);
    enter();
    expect(t.added).toEqual(fillet(0.25));
  });

  it("an emptied box commits the tool's own radius, unmarked", () => {
    const own = Number(input().value);
    type("3.5");
    type("");
    expect(isBad()).toBe(false);
    confirmButton();
    expect(t.added).toEqual(fillet(own));
  });

  it.each(["0", "-2", "abc"])("%j keeps the last valid radius, marks the box, and confirm commits that", (bad) => {
    type("3.5");
    type(bad);
    expect(isBad()).toBe(true);
    confirmButton();
    expect(t.added).toEqual(fillet(3.5));
  });
});
