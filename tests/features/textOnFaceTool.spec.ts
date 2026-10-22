// Text on Face as the user drives it: the first click asks the engine where
// it landed, a round face is written by fingerprint plus (u, v) fractions, a
// flat one by the picked point, and a later drag moves the anchor.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { TextOnFaceTool } from "../../src/features/textOnFaceTool";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { Feature, Selector, Vec3 } from "../../src/types";
import type { FaceAnchorReply } from "../../src/geometry/client";
import { useToolPanelStore } from "../../src/stores/toolPanels";

const FP = { surface: "cylinder", centroid: [0, 0, 0] };

function setup(reply: (point: Vec3) => FaceAnchorReply) {
  const canvas = document.createElement("canvas");
  let hitAt = new THREE.Vector3(0, 20, 0);
  const vp = {
    suspendPicking: false,
    domElement: canvas,
    addToScene: () => {},
    removeFromScene: () => {},
    requestRender: () => {},
    projectToScreen: () => ({ x: 0, y: 0 }),
    clearHover: () => {},
    hoverFaceAt: () => 3,
    pickFaceForPressPull: () => ({
      selector: { kind: "face", by: "nearest", point: [hitAt.x, hitAt.y, hitAt.z] } as Selector,
      faceId: 3,
      normal: new THREE.Vector3(0, 1, 0),
      anchor: hitAt.clone(),
      bodyId: "body1",
    }),
  } as unknown as Viewport;
  const asked: Vec3[] = [];
  const committed: Feature[][] = [];
  let n = 0;
  const store = {
    nextId: () => `f${++n}`,
    setPreview: () => {},
    addFeatures: (f: Feature[]) => {
      committed.push(f);
    },
    faceAnchor: async (_s: Selector, _b: string | null, p: Vec3) => {
      asked.push(p);
      return reply(p);
    },
  } as unknown as DocumentStore;
  const pointer = (type: string) =>
    canvas.dispatchEvent(new PointerEvent(type, { clientX: 5, clientY: 5, button: 0, bubbles: true }));
  return {
    canvas,
    store,
    vp,
    asked,
    committed,
    pointer,
    moveHit: (p: THREE.Vector3) => {
      hitAt = p;
    },
  };
}

const flush = () => new Promise((r) => queueMicrotask(() => r(undefined)));

describe("TextOnFaceTool", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("writes a round face by fingerprint and the click as (u, v) fractions", async () => {
    const s = setup(() => ({ body: "body1", surface: "cylinder", at: [0.25, 0.5], normal: [0, 1, 0], fp: FP }));
    const t = new TextOnFaceTool(s.vp, s.store);
    let done: string | null = null;
    t.start((id) => {
      done = id;
    });
    s.pointer("pointerdown");
    await flush();
    const panel = useToolPanelStore();
    expect(panel.text, "the text panel opens on the first pick").not.toBeNull();
    panel.commitText({ text: "FUNDA", height: 8, style: "regular", align: "center", angle: 0 });
    expect(s.committed).toHaveLength(1);
    const f = s.committed[0]![0] as Record<string, unknown>;
    expect(f).toMatchObject({
      type: "textOnFace",
      text: "FUNDA",
      height: 8,
      depth: 1,
      operation: "join",
      body: "body1",
      face: { kind: "face", by: "match", fp: FP, body: "body1" },
      at: [0.25, 0.5],
      point: [0, 20, 0],
    });
    expect(done).toBe(f.id);
    expect(t.active).toBe(false);
  });

  it("writes a flat face by the picked point, and a drag moves it", async () => {
    const s = setup(() => ({ body: "body1", surface: "plane", at: [0.5, 0.5], normal: [0, 0, 1], fp: FP }));
    const t = new TextOnFaceTool(s.vp, s.store);
    t.start(() => {});
    s.moveHit(new THREE.Vector3(1, 2, 10));
    s.pointer("pointerdown");
    await flush();
    s.pointer("pointerup"); // the release of the picking click
    s.moveHit(new THREE.Vector3(4, -3, 10));
    s.pointer("pointerdown");
    s.moveHit(new THREE.Vector3(6, -5, 10));
    s.pointer("pointermove");
    s.pointer("pointerup");
    await flush();
    expect(s.asked).toEqual([
      [1, 2, 10],
      [6, -5, 10],
    ]);
    useToolPanelStore().commitText({ text: "A", height: 5, style: "bold", align: "left", angle: 0 });
    const f = s.committed[0]![0] as Record<string, unknown>;
    expect(f.face).toEqual({ kind: "face", by: "nearest", point: [6, -5, 10], body: "body1" });
    expect(f.point).toEqual([6, -5, 10]);
    expect(f).not.toHaveProperty("at");
    expect(f).toMatchObject({ style: "bold", align: "left", height: 5 });
  });

  it("refuses a sphere and stays on the pick", async () => {
    const s = setup(() => ({ body: "body1", surface: "sphere", at: [0.5, 0.5], normal: [0, 0, 1] }));
    const t = new TextOnFaceTool(s.vp, s.store);
    t.start(() => {});
    s.pointer("pointerdown");
    await flush();
    expect(useToolPanelStore().text).toBeNull();
    expect(t.active).toBe(true);
    t.cancel();
    expect(t.active).toBe(false);
  });
});
