// Enter right after typing, before a frame has run: the hole takes what is in the box.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { HoleTool } from "../../src/features/holeTool";
import type { DocumentStore, RebuildState } from "../../src/document/store";
import { classifyExprInput } from "../../src/params/engine";
import type { Viewport } from "../../src/viewport/viewport";
import type { Feature } from "../../src/types";
import { setLanguage } from "../../src/i18n";

// The real store reads names in the value box; these fakes hold no parameters.
const classifyTargetExpr: DocumentStore["classifyTargetExpr"] = (bound, pending, raw, kind) =>
  classifyExprInput({ parameters: {}, features: [] }, raw, kind, bound, pending);

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
    boundExpr: () => null,
    classifyTargetExpr,
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
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
      frames.push(fn);
      return frames.length;
    });
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

  it("an edited custom hole shows its diameter with the language's mark and keeps it on Enter", async () => {
    const hole = {
      id: "h7",
      type: "hole",
      holeType: "simple",
      standard: "custom",
      size: "M5",
      diameter: 6.35,
      extent: "blind",
      depth: 12.5,
      face: { by: "plane", point: [3.5, -2, 10], normal: [0, 0, 1] },
      points: [[3.5, -2, 10]],
    } as unknown as Feature;
    const shown: Record<string, string> = {};
    for (const lang of ["en", "de"] as const) {
      await setLanguage(lang);
      const s = fakeStore();
      Object.assign(s.store, {
        document: { parameters: {}, features: [hole] },
        beginEditPreview: () => {},
        setEditPreview: () => {},
        endEditPreview: () => {},
        replaceFeature: (_id: string, f: Feature) => s.added.push(f),
        buildState: { building: false, result: { trackedFaces: {} } },
      });
      const vp = fakeViewport();
      Object.assign(vp, {
        planarFaceThrough: () => ({ normal: new THREE.Vector3(0, 0, 1), origin: new THREE.Vector3(0, 0, 10), faceId: 7 }),
      });
      expect(new HoleTool(vp, s.store).startEdit("h7", () => {})).toBe(true);
      shown[lang] = input("size").value;
      typeThenEnter("size", input("size").value);
      expect(s.added.map((f) => (f as unknown as { diameter: number }).diameter)).toEqual([6.35]);
      document.body.innerHTML = "";
    }
    await setLanguage("system");
    expect(shown).toEqual({ en: "6.35", de: "6,35" });
  });
});
