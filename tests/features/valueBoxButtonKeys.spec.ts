// Confirm and Cancel are Tab stops in the value box, so Enter or Space on one must act as that button. A tool's
// window capture listener hears the key first and used to commit on any Enter outside a text field.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { PatternTool } from "../../src/features/patternTool";
import { isBoxButtonKey } from "../../src/ui/focus";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { Feature } from "../../src/types";

const BODY = new THREE.Box3(new THREE.Vector3(-5, -10, 0), new THREE.Vector3(5, 10, 5));

function fakeViewport() {
  const scene = new THREE.Scene();
  return {
    suspendPicking: false,
    domElement: document.createElement("canvas"),
    addToScene: (o: THREE.Object3D) => scene.add(o),
    removeFromScene: (o: THREE.Object3D) => scene.remove(o),
    bodiesCentroid: () => new THREE.Vector3(),
    facesCentroid: () => new THREE.Vector3(),
    bodiesBox: () => BODY.clone(),
    facesBox: () => BODY.clone(),
    setPatternGhost: () => {},
    setPatternFeatureGhost: () => {},
    clearPatternGhost: () => {},
    clearPatternFeatureGhost: () => {},
    hoverEntity: () => {},
    pixelWorldSize: () => 0.1,
    projectToScreen: () => ({ x: 0, y: 0 }),
    snapStep: () => 1,
  } as unknown as Viewport;
}

function openPattern() {
  const added: Feature[] = [];
  const store = {
    nextId: () => "p1",
    boundExpr: () => null,
    addFeature: (f: Feature) => added.push(f),
    document: { features: [] },
    buildState: { result: { bodies: [{ id: "body1", name: "Body1", faceStart: 0, faceCount: 2, faceOwners: ["b"] }] } },
  } as unknown as DocumentStore;
  const done = vi.fn();
  new PatternTool(fakeViewport(), store).start("rect", ["body1"], done);
  return { added, done };
}

const active = () => document.activeElement as HTMLElement;

function tabTo(cls: string) {
  document.querySelector<HTMLInputElement>(".dim-input input")!.focus();
  for (let i = 0; i < 12 && !active().classList.contains(cls); i++) {
    active().dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  }
  expect(active().classList.contains(cls)).toBe(true);
}

/** A focused button clicks itself on Enter or Space unless a handler prevented the key; happy-dom does not. */
function press(key: string) {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  active().dispatchEvent(ev);
  if (!ev.defaultPrevented) active().click();
  return ev;
}

describe("Enter and Space on the value box buttons", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it.each(["Enter", " "])("%s on a focused Cancel cancels the pattern and adds nothing", (key) => {
    const { added, done } = openPattern();
    tabTo("dim-no");
    press(key);
    vi.runAllTimers();
    expect({ added, calls: done.mock.calls }).toEqual({ added: [], calls: [[null]] });
  });

  it("Enter on a focused Confirm adds the pattern once", () => {
    const { added, done } = openPattern();
    tabTo("dim-ok");
    press("Enter");
    vi.runAllTimers();
    expect({ ids: added.map((f) => f.id), calls: done.mock.calls }).toEqual({ ids: ["p1"], calls: [["p1"]] });
  });

  it("Enter on a box button is the box's, Enter in its field or on the canvas is not", () => {
    const root = document.createElement("div");
    root.className = "dim-input";
    const button = document.createElement("button");
    const field = document.createElement("input");
    root.append(button, field);
    document.body.append(root);
    const key = (k: string, target: EventTarget) => ({ key: k, target }) as unknown as KeyboardEvent;
    expect([
      isBoxButtonKey(key("Enter", button)),
      isBoxButtonKey(key(" ", button)),
      isBoxButtonKey(key("a", button)),
      isBoxButtonKey(key("Enter", field)),
      isBoxButtonKey(key("Enter", document.body)),
    ]).toEqual([true, true, false, false, false]);
  });
});
