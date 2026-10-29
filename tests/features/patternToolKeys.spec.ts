// The body pattern keys: C moves a circular axis, [ ] + - step the count, by the physical key on any layout and only
// while Single key shortcuts are on. Up and Down step the count either way.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { PatternTool } from "../../src/features/patternTool";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { Feature } from "../../src/types";
import { usePromptStore } from "../../src/stores/prompt";
import { setA11yPref } from "../../src/ui/a11yPrefs";

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

type Inner = { count: number; place: string };

const made: PatternTool[] = [];

function open(kind: "circular" | "linear" | "rect") {
  const t = new PatternTool(fakeViewport(), fakeStore().store);
  made.push(t);
  t.start(kind, ["body1"], vi.fn());
  return { t, inner: t as unknown as Inner };
}

function key(k: string, code: string) {
  const e = new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

const prompt = () => usePromptStore().text;

describe("body pattern keys", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    for (const t of made.splice(0)) t.cancel();
    setA11yPref("singleKeys", true);
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("on a Cyrillic layout, C, the brackets and the minus key act by the physical key", () => {
    const { inner } = open("circular");
    const start = inner.count;
    expect([key("с", "KeyC"), key("ъ", "BracketRight"), key("ъ", "BracketRight"), key("х", "BracketLeft")]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect({ place: inner.place, count: inner.count }).toEqual({ place: "centre", count: start + 1 });
  });

  it("with Single key shortcuts off, C, brackets, plus and minus do nothing and the arrows still count", () => {
    setA11yPref("singleKeys", false);
    const { inner } = open("circular");
    const start = inner.count;
    const pressed = [
      key("c", "KeyC"),
      key("]", "BracketRight"),
      key("+", "Equal"),
      key("[", "BracketLeft"),
      key("-", "Minus"),
    ];
    expect(pressed).toEqual([false, false, false, false, false]);
    expect({ place: inner.place, count: inner.count }).toEqual({ place: "origin", count: start });
    expect(key("ArrowUp", "ArrowUp")).toBe(true);
    expect(inner.count).toBe(start + 1);
  });

  it("with Single key shortcuts off, the prompt names Up and Down for the count and drops C", () => {
    const on = (["circular", "linear", "rect"] as const).map((kind) => {
      const { t } = open(kind);
      const text = prompt();
      t.cancel();
      return text;
    });
    setA11yPref("singleKeys", false);
    const off = (["circular", "linear", "rect"] as const).map((kind) => {
      const { t } = open(kind);
      const text = prompt();
      t.cancel();
      return text;
    });
    expect(off).toEqual([
      on[0]!.replace(" · C origin or middle · [ ] count ·", " · Up and Down count ·"),
      on[1]!.replace(" · [ and ] change the count ·", " · Up and Down change the count ·"),
      on[2]!.replace(" · [ ] X count ·", " · Up and Down X count ·"),
    ]);
    expect(off.map((p, i) => p !== on[i])).toEqual([true, true, true]);
  });
});
