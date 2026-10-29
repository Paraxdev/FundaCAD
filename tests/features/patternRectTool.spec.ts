// The body Rect pattern tool: the feature it commits and the spacings it keeps while arrows are swapped.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { PatternTool } from "../../src/features/patternTool";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { Feature } from "../../src/types";

const BODY = new THREE.Box3(new THREE.Vector3(-5, -10, 0), new THREE.Vector3(5, 10, 5)); // 10 by 20
const FACE = new THREE.Box3(new THREE.Vector3(-2, -2, 5), new THREE.Vector3(2, 2, 5)); // 4 by 4

function fakeViewport() {
  const canvas = document.createElement("canvas");
  const scene = new THREE.Scene();
  return {
    suspendPicking: false,
    domElement: canvas,
    addToScene: (o: THREE.Object3D) => scene.add(o),
    removeFromScene: (o: THREE.Object3D) => scene.remove(o),
    bodiesCentroid: () => new THREE.Vector3(),
    facesCentroid: () => new THREE.Vector3(),
    bodiesBox: () => BODY.clone(),
    facesBox: () => FACE.clone(),
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

function fakeStore() {
  const added: Feature[] = [];
  const store = {
    nextId: () => "p1",
    addFeature: (f: Feature) => added.push(f),
    document: { features: [{ id: "h", type: "hole" }] },
    buildState: {
      result: { bodies: [{ id: "body1", name: "Body1", faceStart: 0, faceCount: 2, faceOwners: ["b", "h"] }] },
    },
  };
  return { store: store as unknown as DocumentStore, added };
}

type Inner = {
  count: number;
  countY: number;
  value: number;
  valueY: number;
  axis: number;
  hitAxis: () => number;
  dragAt: () => number;
  onDown: (e: unknown) => void;
  onUp: (e: unknown) => void;
  commit: () => void;
};

function open(features?: string[]) {
  const s = fakeStore();
  const t = new PatternTool(fakeViewport(), s.store);
  const done = vi.fn();
  t.start("rect", features ? [] : ["body1"], done, features);
  return { t, s, done, inner: t as unknown as Inner };
}

describe("body Rect pattern tool", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("commits a patternRect on the bodies, one span apart in each direction", () => {
    const { inner, s, done } = open();
    inner.commit();
    expect(s.added).toEqual([
      { id: "p1", type: "patternRect", countX: 3, countY: 3, spacingX: 10, spacingY: 20, bodies: ["body1"] },
    ]);
    expect(done).toHaveBeenCalledWith("p1");
  });

  it("commits a patternRect on the features a face pick names, with no bodies", () => {
    const { inner, s } = open(["h"]);
    inner.commit();
    expect(s.added).toEqual([
      { id: "p1", type: "patternRect", countX: 3, countY: 3, spacingX: 4, spacingY: 4, features: ["h"] },
    ]);
  });

  it("refuses a 1 by 1 grid and adds nothing", () => {
    const { inner, s, done } = open();
    inner.count = 1;
    inner.countY = 1;
    inner.commit();
    expect(s.added).toEqual([]);
    expect(done).toHaveBeenCalledWith(null);
  });

  it("keeps each spacing when the other arrow is pressed", () => {
    const { inner } = open();
    inner.value = 40;
    inner.valueY = 30;
    inner.dragAt = () => 0;
    const down = { button: 0, clientX: 0, clientY: 0, preventDefault: () => {}, stopImmediatePropagation: () => {} };
    inner.hitAxis = () => 1;
    inner.onDown(down);
    inner.onUp({ button: 0, clientX: 0, clientY: 0 });
    inner.hitAxis = () => 0;
    inner.onDown(down);
    expect([inner.value, inner.valueY]).toEqual([40, 30]);
  });
});
