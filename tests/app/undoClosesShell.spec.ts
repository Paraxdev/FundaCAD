// Menu Undo with a new Shell, Offset Face or Thicken open: the tool rests on the step that owns the faces it picked,
// which it neither re-edits nor previews, so an undo of that step left it open on faces that are gone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";

vi.mock("../../src/ui/home", () => ({ closeHome: () => {} }));

import { DocumentStore } from "../../src/document/store";
import { FaceOffsetTool, type FaceOffsetMode } from "../../src/features/faceOffsetTool";
import { closeToolOnLostStep, createSelection } from "../../src/app/selection";
import { createDocumentActions } from "../../src/app/documentActions";
import type { Engine } from "../../src/app/engine";
import type { Selector } from "../../src/types";
import type { Viewport } from "../../src/viewport/viewport";
import { box, stubBackend } from "../document/storeKit";

let frames: (() => void)[] = [];
const flushFrame = () => {
  const run = frames;
  frames = [];
  for (const f of run) f();
};

function lenient<T>(own: Record<string, unknown>): T {
  return new Proxy(own, { get: (t, k) => (k in t ? t[k as string] : () => undefined) }) as unknown as T;
}

const face = (x: number): Selector => ({ kind: "face", by: "nearest", point: [x, 0, 0] });

// Faces 0 to 5 are b1's, 6 to 11 the boss b2's, all on the one body.
const OWNERS = [...Array<string>(6).fill("b1"), ...Array<string>(6).fill("b2")];

function fakeViewport(picked: number) {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, -500, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return lenient<Viewport>({
    suspendPicking: false,
    domElement: document.createElement("canvas"),
    camera,
    addToScene: () => {},
    removeFromScene: () => {},
    probe: () => null,
    pixelWorldSize: () => 0.1,
    modelDiagonal: () => 100,
    projectToScreen: () => ({ x: 0, y: 0 }),
    snapStep: () => 0.05,
    thicknessBehind: () => null,
    roundFaceAt: () => null,
    faceTriangles: () => [],
    faceIdToBodyId: () => "body1",
    hoverFaceAt: () => null,
    selectedFacesForPressPull: () => ({
      selectors: [face(picked)],
      faceIds: [picked],
      normal: new THREE.Vector3(0, 0, 1),
      anchor: new THREE.Vector3(0, 0, 0),
      bodyId: "body1",
      round: null,
    }),
    pickFaceForPressPull: () => ({
      selector: face(9),
      faceId: 9,
      normal: new THREE.Vector3(0, 0, 1),
      anchor: new THREE.Vector3(9, 0, 0),
      bodyId: "body1",
    }),
  });
}

function rig(picked: number) {
  const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
  Object.defineProperty(store, "buildState", {
    get: () => ({
      building: false,
      result: { bodies: [{ id: "body1", faceStart: 0, faceCount: OWNERS.length, faceOwners: OWNERS }] },
    }),
  });
  const vp = fakeViewport(picked);
  const faceOffset = new FaceOffsetTool(vp, store);
  const idle = { active: false, pending: false, cancel() {}, profileSketches: [] };
  const atWork = () => faceOffset.active;
  const e = {
    store,
    tools: new Proxy({ faceOffset }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : idle) }),
    viewport: vp,
    sketch: { active: false, undoEdit: () => false, redoEdit: () => false },
    ui: { panels: { undoStress: () => false, redoStress: () => false } },
    toolBusy: atWork,
    toolAtWork: atWork,
    dropBodyGizmo: () => {},
    setStatus: () => {},
    noteCommitted: () => {},
  } as unknown as Engine;
  Object.assign(e, createSelection(e), createDocumentActions(e));
  closeToolOnLostStep(e);
  opened.push(faceOffset);
  return { e, store, tool: faceOffset, canvas: vp.domElement };
}

const ids = (s: DocumentStore) => s.document.features.map((f) => f.id);
const input = () => document.querySelector<HTMLInputElement>(".dim-input input")!;

let opened: FaceOffsetTool[] = [];
beforeEach(() => {
  setActivePinia(createPinia());
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => frames.push(fn));
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  for (const t of opened.splice(0)) if (t.active) t.cancel();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("an Undo that removes the step owning a face a tool picked", () => {
  it.each(["shell", "offsetFace", "thicken"] as FaceOffsetMode[])(
    "closes a new %s on that face, keeps the redo, and Enter writes nothing",
    (mode) => {
      const { e, store, tool } = rig(8);
      store.addFeature(box("b1", 20));
      store.addFeature(box("b2", 6));

      tool.start(mode, () => {});
      flushFrame();
      expect(tool.active).toBe(true);
      const field = input();

      e.doUndo();

      expect(tool.active).toBe(false);
      expect(ids(store)).toEqual(["b1"]);
      const doc = store.toJSON();
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      flushFrame();
      expect(store.toJSON()).toBe(doc);
      expect(store.redoLabel).not.toBeNull();
      store.redo();
      expect(ids(store)).toEqual(["b1", "b2"]);
    },
  );

  it("closes a Shell when the undone step owns only a face added with Ctrl-click", () => {
    const { e, store, tool, canvas } = rig(2);
    store.addFeature(box("b1", 20));
    store.addFeature(box("b2", 6));

    tool.start("shell", () => {});
    canvas.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 0, clientY: 0, button: 0, ctrlKey: true, bubbles: true }),
    );
    expect(tool.active).toBe(true);
    e.doUndo();

    expect(tool.active).toBe(false);
  });

  it("leaves the Shell open when the undo removes a later step that owns none of its faces", () => {
    const { e, store, tool } = rig(8);
    store.addFeature(box("b1", 20));
    store.addFeature(box("b2", 6));
    store.addFeature(box("b3", 30));

    tool.start("shell", () => {});
    e.doUndo();

    expect(ids(store)).toEqual(["b1", "b2"]);
    expect(tool.active).toBe(true);
  });
});
