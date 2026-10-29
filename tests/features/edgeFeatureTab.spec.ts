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
const done = vi.fn();

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
  tool.start("fillet", done);
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

/** A focused button clicks itself on Enter unless a handler prevented the key; happy-dom does not. */
function press(key: string, shiftKey = false) {
  const el = document.activeElement as HTMLElement;
  const ev = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  if (key === "Enter" && !ev.defaultPrevented) el.click();
}

function stopName(): string {
  const el = document.activeElement as HTMLElement;
  if (el === input()) return "field";
  if (el.classList.contains("profile-chip")) return "chip";
  if (el.classList.contains("dim-segment")) return `segment ${el.dataset.id}`;
  if (el.classList.contains("dim-ok")) return "confirm";
  if (el.classList.contains("dim-no")) return "cancel";
  return el.className;
}

describe("Tab in the fillet box", () => {
  let tool: EdgeFeatureTool;
  beforeEach(() => {
    setActivePinia(createPinia());
    done.mockReset();
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

  it("Shift+Tab from the field steps back onto Cancel without flipping, and on to the profile chip", () => {
    input().focus();
    const walk: string[] = [];
    for (let i = 0; i < 5; i++) {
      press("Tab", true);
      walk.push(stopName());
    }
    expect({ kind: tool.blendKind(), walk }).toEqual({
      kind: "fillet",
      walk: ["cancel", "confirm", "segment G1", "chip", "field"],
    });
  });

  it("Tab on the profile chip walks forward and leaves the box off Cancel, it does not flip", () => {
    document.querySelector<HTMLElement>(".profile-chip")!.focus();
    const walk: string[] = [];
    for (let i = 0; i < 3; i++) {
      press("Tab");
      walk.push(stopName());
    }
    const last = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(last);
    expect({ kind: tool.blendKind(), walk, leaves: !last.defaultPrevented }).toEqual({
      kind: "fillet",
      walk: ["segment G1", "confirm", "cancel"],
      leaves: true,
    });
  });

  it("Enter on the focused profile chip opens its panel and does not apply the fillet", () => {
    const chip = document.querySelector<HTMLElement>(".profile-chip")!;
    chip.focus();
    press("Enter");
    expect({ open: chip.getAttribute("aria-expanded"), done: done.mock.calls }).toEqual({ open: "true", done: [] });
  });
});
