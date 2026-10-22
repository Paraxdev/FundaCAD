// Draft as the user types it: an Enter before the kernel has answered commits
// once the answer lands, and a refused value leaves the tool open and says why.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { DraftTool } from "../../src/features/draftTool";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { Feature, Selector } from "../../src/types";
import { usePromptStore } from "../../src/stores/prompt";

let frames: (() => void)[] = [];
const flushFrame = () => {
  const run = frames;
  frames = [];
  for (const f of run) f();
};

const FACE: Selector = { kind: "face", by: "nearest", point: [0, 0, 0] };

function fakeViewport() {
  const canvas = document.createElement("canvas");
  const scene = new THREE.Scene();
  const vp = {
    suspendPicking: false,
    domElement: canvas,
    addToScene: (o: THREE.Object3D) => scene.add(o),
    removeFromScene: (o: THREE.Object3D) => scene.remove(o),
    requestRender: () => {},
    pixelWorldSize: () => 0.1,
    projectToScreen: () => ({ x: 0, y: 0 }),
    probe: () => null,
    clearHover: () => {},
    hoverFaceAt: () => null,
    selectedFacesForPressPull: () => ({
      selectors: [FACE],
      faceIds: [7],
      normal: new THREE.Vector3(1, 0, 0),
      anchor: new THREE.Vector3(0, 0, 5),
      bodyId: "b1",
    }),
  };
  return vp as unknown as Viewport;
}

function fakeStore() {
  const added: Feature[] = [];
  const verified: string[] = [];
  const state = { hasPreview: false, previewError: null as string | null, building: false };
  const store = {
    nextId: () => "p1",
    setPreview(feature: Feature | null) {
      state.hasPreview = feature !== null;
      if (feature) state.building = true;
    },
    addFeature: (f: Feature) => added.push(f),
    verifyCommit: (id: string) => verified.push(id),
    get hasPreview() {
      return state.hasPreview;
    },
    get previewError() {
      return state.building ? null : state.previewError;
    },
    get buildState() {
      return { building: state.building, result: null };
    },
  };
  return { store: store as unknown as DocumentStore, state, added, verified };
}

function typeAngle(value: string) {
  const input = [...document.querySelectorAll<HTMLInputElement>(".dim-input input")].at(-1)!;
  input.value = value;
  input.dispatchEvent(new Event("input"));
  return () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

describe("DraftTool Enter", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
      frames.push(fn);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("stays open on an Enter that beats the first preview of the typed angle", () => {
    const s = fakeStore();
    const t = new DraftTool(fakeViewport(), s.store);
    let done: string | null | undefined;
    t.start((id) => {
      done = id;
    });
    typeAngle("5")();
    expect(s.added).toHaveLength(0);
    expect(done).toBeUndefined();
    expect(t.active).toBe(true);
    expect(usePromptStore().text).toMatch(/Checking the draft/);
  });

  it("commits on one Enter pressed while the kernel is still answering, once the answer lands", () => {
    const s = fakeStore();
    const t = new DraftTool(fakeViewport(), s.store);
    t.start(() => {});
    const enter = typeAngle("5");
    flushFrame();
    enter();
    expect(s.added).toHaveLength(0);
    expect(t.active).toBe(true);
    expect(usePromptStore().text).toMatch(/Checking the draft/);
    s.state.building = false;
    flushFrame();
    expect(s.added).toHaveLength(1);
    expect(s.added[0]).toMatchObject({ type: "draft", angle: 5 });
    expect(s.verified).toHaveLength(0);
    expect(t.active).toBe(false);
  });

  /** Types 45, which the kernel refuses, and presses Enter on it. */
  function refuse45(s: ReturnType<typeof fakeStore>, reason = "draft failed for these faces / angle") {
    const enter = typeAngle("45");
    flushFrame();
    s.state.building = false;
    s.state.previewError = reason;
    flushFrame();
    enter();
    expect(s.added).toHaveLength(0);
    expect(usePromptStore().text).toMatch(/Draft refused/);
  }

  for (const enterBeforeFrame of [false, true]) {
    it(`commits a good value typed after a refusal on one Enter, pressed ${enterBeforeFrame ? "before" : "after"} the frame that reads it`, () => {
      const s = fakeStore();
      const t = new DraftTool(fakeViewport(), s.store);
      let done: string | null | undefined;
      t.start((id) => {
        done = id;
      });
      refuse45(s);
      const enter = typeAngle("10");
      if (!enterBeforeFrame) flushFrame();
      enter();
      expect(s.state.building).toBe(true);
      expect(s.added).toHaveLength(0);
      flushFrame();
      expect(s.added).toHaveLength(0);
      s.state.building = false;
      s.state.previewError = null;
      flushFrame();
      expect(s.added).toHaveLength(1);
      expect(s.added[0]).toMatchObject({ type: "draft", angle: 10 });
      expect(done).toBe("p1");
    });
  }

  it("says the pending value was refused when the kernel answers no, and stays open", () => {
    const s = fakeStore();
    const t = new DraftTool(fakeViewport(), s.store);
    t.start(() => {});
    typeAngle("30")();
    s.state.building = false;
    s.state.previewError = "Draft: the face would fold over itself";
    flushFrame();
    expect(s.added).toHaveLength(0);
    expect(t.active).toBe(true);
    expect(usePromptStore().text).toMatch(/Draft refused: Draft: the face would fold over itself/);
  });

  it("still says refused when a second value is refused with the same reason", () => {
    const s = fakeStore();
    const t = new DraftTool(fakeViewport(), s.store);
    t.start(() => {});
    refuse45(s);
    typeAngle("50")();
    expect(usePromptStore().text).toMatch(/Checking the draft/);
    s.state.building = false;
    flushFrame();
    expect(s.added).toHaveLength(0);
    expect(t.active).toBe(true);
    expect(usePromptStore().text).toMatch(/Draft refused: draft failed/);
  });

  it("commits once for two Enters pressed while the answer is pending", () => {
    const s = fakeStore();
    const t = new DraftTool(fakeViewport(), s.store);
    t.start(() => {});
    const enter = typeAngle("5");
    flushFrame();
    enter();
    enter();
    s.state.building = false;
    flushFrame();
    flushFrame();
    expect(s.added).toHaveLength(1);
  });

  it("drops the waiting Enter when another value is typed before the answer", () => {
    const s = fakeStore();
    const t = new DraftTool(fakeViewport(), s.store);
    t.start(() => {});
    typeAngle("5")();
    typeAngle("7");
    flushFrame();
    s.state.building = false;
    flushFrame();
    expect(s.added).toHaveLength(0);
    expect(t.active).toBe(true);
    expect(usePromptStore().text).toMatch(/drag or type an angle/);
  });

  it("says why it refused on an Enter that lands before the next frame", () => {
    const s = fakeStore();
    const t = new DraftTool(fakeViewport(), s.store);
    t.start(() => {});
    const enter = typeAngle("80");
    flushFrame();
    s.state.building = false;
    s.state.previewError = "Draft: the face would fold over itself";
    enter();
    expect(s.added).toHaveLength(0);
    expect(t.active).toBe(true);
    expect(usePromptStore().text).toMatch(/Draft refused: Draft: the face would fold over itself/);
  });
});
