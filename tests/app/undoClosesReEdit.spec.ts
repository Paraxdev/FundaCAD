// Menu Undo with an untouched Revolve, joint or mechanism edit open: the tool had begun no edit preview, so it stayed
// on the step the undo removed, and Enter wrote to that step and lost the redo.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";

vi.mock("../../src/ui/home", () => ({ closeHome: () => {} }));

import { DocumentStore } from "../../src/document/store";
import { RevolvePitchTool } from "../../src/features/revolvePitchTool";
import { JointTool } from "../../src/features/jointTool";
import { MechanismTool } from "../../src/features/mechanismTool";
import { closeToolOnLostStep, createSelection } from "../../src/app/selection";
import { createDocumentActions } from "../../src/app/documentActions";
import type { Engine } from "../../src/app/engine";
import type { Feature } from "../../src/types";
import type { Viewport } from "../../src/viewport/viewport";
import type { SketchOverlay } from "../../src/sketch/overlay";
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

function fakeViewport() {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, -500, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return lenient<Viewport>({
    suspendPicking: false,
    domElement: document.createElement("canvas"),
    camera,
    probe: () => null,
    pixelWorldSize: () => 0.1,
    projectToScreen: () => ({ x: 0, y: 0 }),
    snapStep: () => 0.5,
  });
}

const AXIS_MARK = { kind: "axis", origin: [0, 0, 0], dir: [0, 0, 1] };

const STEP = {
  revolve: { id: "r1", type: "revolve", sketch: "s1", axis: "Z", angle: 360, regions: [[5, 0, 0]] },
  joint: { id: "j1", type: "joint", offset: 3, angle: 20 },
  mechanism: { id: "m1", type: "mechanism", drive: "d1", joints: [{ id: "d1", mode: "slider" }], offset: 4 },
} as unknown as Record<"revolve" | "joint" | "mechanism", Feature>;

function rig() {
  const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
  // The joint and mechanism handles stand on the mate axis only a build places.
  Object.defineProperty(store, "buildState", {
    get: () => ({ building: false, result: { datumMarks: { j1: AXIS_MARK, m1: AXIS_MARK } } }),
  });
  const vp = fakeViewport();
  const tools = {
    revolve: new RevolvePitchTool(vp, store, lenient<SketchOverlay>({})),
    joint: new JointTool(vp, store),
    mechanism: new MechanismTool(vp, store),
  };
  const idle = { active: false, pending: false, cancel() {}, profileSketches: [] };
  const atWork = () => Object.values(tools).some((t) => t.active);
  const e = {
    store,
    tools: new Proxy(
      { revolvePitch: tools.revolve, joint: tools.joint, mechanism: tools.mechanism },
      { get: (t, k) => (k in t ? t[k as keyof typeof t] : idle) },
    ),
    viewport: lenient<Viewport>({}),
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
  return { e, store, tools };
}

const field = (name: string) => document.querySelector<HTMLInputElement>(`.dim-field[data-field="${name}"] input`)!;
const ids = (s: DocumentStore) => s.document.features.map((f) => f.id);
const press = (input: HTMLInputElement) =>
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

let opened: { active: boolean; cancel(): void }[] = [];
beforeEach(() => {
  setActivePinia(createPinia());
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => frames.push(fn));
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  for (const t of opened.splice(0)) if (t.active) t.cancel();
  opened = [];
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("an Undo that removes the step a tool re-edits", () => {
  it.each([
    ["Revolve", "revolve", "pitch"],
    ["joint", "joint", "offset"],
    ["mechanism", "mechanism", "offset"],
  ] as const)("closes an untouched %s edit, keeps the redo, and Enter writes nothing", (_name, kind, name) => {
    const { e, store, tools } = rig();
    const tool = tools[kind];
    opened.push(tool);
    store.addFeature(box("b1", 20));
    store.addFeature(STEP[kind]);
    const id = STEP[kind].id;

    e.editFeature(id);
    flushFrame();
    expect(tool.active).toBe(true);
    const input = field(name);
    expect(input).toBeTruthy();

    e.doUndo();

    expect(tool.active).toBe(false);
    expect(ids(store)).toEqual(["b1"]);
    const doc = store.toJSON();
    press(input);
    flushFrame();
    expect(store.toJSON()).toBe(doc);
    expect(store.redoLabel).not.toBeNull();
    store.redo();
    expect(ids(store)).toEqual(["b1", id]);
  });

  it("leaves the edit open when the undo removes a later step", () => {
    const { e, store, tools } = rig();
    opened.push(tools.joint);
    store.addFeature(box("b1", 20));
    store.addFeature(STEP.joint);
    store.addFeature(box("b2", 30));

    e.editFeature("j1");
    e.doUndo();

    expect(ids(store)).toEqual(["b1", "j1"]);
    expect(tools.joint.active).toBe(true);
  });

  it("closes the edit on any document change that removes its step, not only an undo", () => {
    const { e, store, tools } = rig();
    opened.push(tools.mechanism);
    store.addFeature(box("b1", 20));
    store.addFeature(STEP.mechanism);

    e.editFeature("m1");
    store.removeFeature("m1");

    expect(tools.mechanism.active).toBe(false);
  });

  it("forgets the step once its edit is closed, so a later removal leaves the next tool open", () => {
    const { e, store, tools } = rig();
    opened.push(tools.joint, tools.revolve);
    store.addFeature(box("b1", 20));
    store.addFeature(STEP.joint);
    store.addFeature(STEP.revolve);

    e.editFeature("j1");
    tools.joint.cancel();
    e.editFeature("r1");
    store.removeFeature("j1");

    expect(tools.revolve.active).toBe(true);
  });
});
