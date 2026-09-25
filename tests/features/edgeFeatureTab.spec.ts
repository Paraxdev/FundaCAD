// Tab in a fillet or chamfer box flips the treatment, from a capture listener
// that runs before the box's own Tab handling. The box's check on what was typed
// has to happen anyway: a refused value stays with its reason and nothing flips.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { EdgeFeatureTool } from "../../src/features/edgeFeatureTool";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";

/** Any viewport or store method the tool reaches for and this test does not
 *  care about is a no-op. */
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
  const store = lenient<DocumentStore>({
    document: { features: [], parameters: {} },
    nextId: () => `f${++n}`,
    onBuild: () => () => {},
    isParamBound: () => false,
    bareParamRef: () => null,
  });
  const tool = new EdgeFeatureTool(vp, store);
  tool.start("fillet", () => {});
  return tool;
}

const input = () => document.querySelector<HTMLInputElement>(".dim-input input")!;
const problem = () => document.querySelector(".dim-problem")?.textContent ?? null;

function type(text: string) {
  input().value = text;
  input().dispatchEvent(new Event("input", { bubbles: true }));
}
function tab() {
  input().dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
}

describe("Tab in the fillet box", () => {
  let tool: EdgeFeatureTool;
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    tool = setup();
  });
  afterEach(() => {
    tool?.cancel();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it.each([
    ["-2", /must be more than 0/],
    ["abc", /"abc" is not a number/],
    ["1,000", /ambiguous/],
  ])("refuses %s with its reason and does not flip", (text, reason) => {
    type(text);
    tab();
    expect(problem()).toMatch(reason);
    expect(tool.blendKind()).toBe("fillet");
    expect(input().value).toBe(text);
  });

  it("flips to a chamfer carrying a typed value it accepts", () => {
    type("2,5");
    tab();
    expect(problem()).toBeNull();
    expect(tool.blendKind()).toBe("chamfer");
    expect(Number(input().value)).toBeCloseTo(2.5);
  });
});
