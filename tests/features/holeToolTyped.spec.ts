// Enter right after typing, before a frame has run: the hole takes what is in the box.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { HoleTool } from "../../src/features/holeTool";
import type { DocumentStore, RebuildState } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { Feature } from "../../src/types";

let frames: (() => void)[] = [];

function fakeViewport() {
  const canvas = document.createElement("canvas");
  const vp = {
    suspendPicking: false,
    domElement: canvas,
    addToScene: () => {},
    removeFromScene: () => {},
    requestRender: () => {},
    pixelWorldSize: () => 0.1,
    projectToScreen: () => ({ x: 0, y: 0 }),
    clearHover: () => {},
    hoverFaceAt: () => null,
    pickFaceForPressPull: () => null,
    selectedFacesForPressPull: () => ({ faceIds: [7], bodyId: "b1" }),
    planarFace: () => ({ normal: new THREE.Vector3(0, 0, 1), origin: new THREE.Vector3(0, 0, 10) }),
    faceAreaCentroidWorld: () => new THREE.Vector3(0, 0, 10),
    modelBox: () => new THREE.Box3(new THREE.Vector3(-10, -10, 0), new THREE.Vector3(10, 10, 10)),
  };
  return vp as unknown as Viewport;
}

function fakeStore() {
  const added: Feature[] = [];
  const store = {
    nextId: () => "h1",
    setPreview: () => {},
    addFeature: (f: Feature) => added.push(f),
    verifyCommit: () => {},
    onBuild: () => () => {},
    hasPreview: false,
    previewError: null,
    buildState: { building: false } as RebuildState,
    document: { parameters: {}, features: [] },
    isParamBound: () => false,
  };
  return { store: store as unknown as DocumentStore, added };
}

function input(name: string) {
  return document.querySelector<HTMLInputElement>(`label.dim-field[data-field="${name}"] input`)!;
}

function typeThenEnter(name: string, text: string) {
  const el = input(name);
  el.value = text;
  el.dispatchEvent(new Event("input"));
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

describe("HoleTool typed values", () => {
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

  it("commits the size typed just before Enter", () => {
    const s = fakeStore();
    new HoleTool(fakeViewport(), s.store).start(() => {});
    typeThenEnter("size", "M6");
    expect(s.added).toHaveLength(1);
    expect((s.added[0] as unknown as { size: string }).size).toBe("M6");
  });

  it("commits the depth typed just before Enter", () => {
    const s = fakeStore();
    new HoleTool(fakeViewport(), s.store).start(() => {});
    typeThenEnter("depth", "5");
    expect(s.added).toHaveLength(1);
    expect((s.added[0] as unknown as { depth: number }).depth).toBe(5);
  });
});
