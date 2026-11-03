// Every tool that keeps its own value, in its real box: Ctrl+Z taking a field's typing back hands the tool the value
// it held, the next frames leave it, and Enter commits what the field shows.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { DatumPoseTool } from "../../src/features/datumPoseTool";
import { ExtrudeTool } from "../../src/features/extrudeTool";
import { JointTool } from "../../src/features/jointTool";
import { MechanismTool } from "../../src/features/mechanismTool";
import { PlaneOffsetTool } from "../../src/features/planeOffsetTool";
import { PressPullTool } from "../../src/features/pressPullTool";
import { TextOnFaceTool } from "../../src/features/textOnFaceTool";
import { ThreadTool } from "../../src/features/threadTool";
import { SketchPlane } from "../../src/sketch/plane";
import { PatternFlow, type PatternHost } from "../../src/sketch/patternFlow";
import { DimInput } from "../../src/sketch/dimInput";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { Selector } from "../../src/types";

let frames: (() => void)[] = [];
const flushFrame = () => {
  const run = frames;
  frames = [];
  for (const f of run) f();
};

function lenient<T>(own: Record<string, unknown>): T {
  return new Proxy(own, {
    get: (t, k) => (k in t ? t[k as string] : () => undefined),
  }) as unknown as T;
}

const FACE: Selector = { kind: "face", by: "nearest", point: [0, 0, 0] };
const AXIS_MARK = { kind: "axis", origin: [0, 0, 0], dir: [0, 0, 1] };

function fakeViewport(extra: Record<string, unknown> = {}) {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, -500, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const rayFrom = (_x: number, y: number) =>
    new THREE.Raycaster(new THREE.Vector3(-200, 0, y / 10), new THREE.Vector3(1, 0, 0));
  return lenient<Viewport>({
    suspendPicking: false,
    domElement: document.createElement("canvas"),
    camera,
    rayFrom,
    probe: <T>(x: number, y: number, test: (rc: THREE.Raycaster) => T) => test(rayFrom(x, y)) || null,
    pixelWorldSize: () => 0.1,
    projectToScreen: () => ({ x: 0, y: 0 }),
    snapStep: () => 0.5,
    modelDiagonal: () => 100,
    pickFaceForPressPull: () => null,
    roundFaceAt: () => null,
    faceTriangles: () => [],
    thicknessBehind: () => null,
    pointInSolid: () => false,
    selectedFacesForPressPull: () => ({
      selectors: [FACE],
      faceIds: [7],
      normal: new THREE.Vector3(0, 0, 1),
      anchor: new THREE.Vector3(0, 0, 0),
      bodyId: "b1",
      round: null,
    }),
    ...extra,
  });
}

/** Every write a commit makes, in the order it made them. */
function fakeStore(extra: Record<string, unknown> = {}) {
  const written: unknown[] = [];
  let n = 0;
  const store = lenient<DocumentStore>({
    document: { features: [], parameters: {} },
    nextId: () => `f${++n}`,
    addFeature: (f: unknown) => written.push(f),
    addFeatures: (f: unknown[]) => written.push(...f),
    updateFeature: (id: string, patch: unknown) => written.push([id, patch]),
    onBuild: () => () => {},
    onSessionBuild: () => () => {},
    faceAxis: async () => null,
    isParamBound: () => false,
    bareParamRef: () => null,
    boundExpr: () => null,
    hasPreview: false,
    previewError: null,
    hiddenBodyIds: () => undefined,
    buildState: { building: false, result: null },
    ...extra,
  });
  return { store, written };
}

function pointer(canvas: HTMLElement, type: string, y: number) {
  canvas.dispatchEvent(new PointerEvent(type, { clientX: 0, clientY: y, button: 0, bubbles: true, cancelable: true }));
}

function dragHandle(canvas: HTMLElement, to: number) {
  flushFrame();
  pointer(canvas, "pointerdown", 0);
  pointer(canvas, "pointermove", to / 2);
  pointer(canvas, "pointermove", to);
  vi.advanceTimersByTime(500);
  pointer(canvas, "pointerup", to);
}

function typeInto(input: HTMLInputElement, text: string, inputType = "insertText") {
  input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType }));
  input.value = text;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
}

const pickOf =
  (...keys: string[]) =>
  (f: unknown) =>
    Object.fromEntries(keys.map((k) => [k, (f as Record<string, unknown>)[k]]));

interface Opened {
  held: () => unknown;
  written: () => unknown[];
  /** For a tool that reads its box on a pointer move, not on a frame. */
  pointerMoved?: () => void;
}

type Internals = Record<string, unknown> & { cancel(): void; active: boolean };
const inner = (tool: object) => tool as unknown as Internals;
const opened: Internals[] = [];
function track<T extends object>(tool: T): T {
  opened.push(inner(tool));
  return tool;
}

function joint(name: "offset" | "angle"): Opened {
  const { store, written } = fakeStore({
    document: { features: [{ id: "j1", type: "joint", offset: 3, angle: 20 }], parameters: {} },
    buildState: { result: { datumMarks: { j1: AXIS_MARK } } },
  });
  const tool = track(new JointTool(fakeViewport(), store));
  expect(tool.startEdit("j1", () => {})).toBe(true);
  return { held: () => inner(tool)[name], written: () => written };
}

function mechanism(): Opened {
  const mech = { id: "m1", type: "mechanism", drive: "d1", joints: [{ id: "d1", mode: "slider" }], offset: 4 };
  const { store, written } = fakeStore({
    document: { features: [mech], parameters: {} },
    buildState: { result: { datumMarks: { m1: AXIS_MARK } } },
  });
  const tool = track(new MechanismTool(fakeViewport(), store));
  expect(tool.startEdit("m1", () => {})).toBe(true);
  return { held: () => inner(tool).value, written: () => written };
}

function thread(name: "pitch" | "length"): Opened {
  const at = (z: number) => new THREE.Vector3(5, 0, z);
  const vp = fakeViewport({
    faceTriangles: () => [{ a: at(0), b: at(20), c: at(10) }],
    selectedFacesForPressPull: () => ({
      selectors: [FACE],
      faceIds: [7],
      normal: new THREE.Vector3(1, 0, 0),
      anchor: at(10),
      bodyId: "b1",
      round: {
        radius: 5,
        solidInside: true,
        cylinder: { axis: [0, 0, 1], point: [0, 0, 0] },
        radial: new THREE.Vector3(1, 0, 0),
      },
    }),
  });
  const { store, written } = fakeStore();
  const tool = track(new ThreadTool(vp, store));
  tool.start(() => {});
  return { held: () => inner(tool)[name], written: () => written.map(pickOf("type", "pitch", "length")) };
}

function textOnFace(): Opened {
  const { store, written } = fakeStore();
  const tool = track(new TextOnFaceTool(fakeViewport(), store));
  tool.start(() => {});
  Object.assign(tool, { anchor: { face: FACE, body: "b1", point: [0, 0, 0], at: null } });
  (tool as unknown as { beginType(at: { x: number; y: number }): void }).beginType({ x: 0, y: 0 });
  return { held: () => inner(tool).depth, written: () => written.map(pickOf("type", "depth")) };
}

function datumPose(name: "offset" | "tiltX" | "tiltY" | "spin"): Opened {
  const pose = { offset: 4, shiftX: 0, shiftY: 0, tiltX: 10, tiltY: 20, spin: 30 };
  const written: unknown[] = [];
  const tool = track(new DatumPoseTool(fakeViewport()));
  tool.start({ src: "XY", pose, ghost: false, onStep: (p) => written.push(p) }, () => {});
  return { held: () => (inner(tool).pose as Record<string, number>)[name], written: () => written };
}

function planeOffset(): Opened {
  const written: unknown[] = [];
  const tool = track(new PlaneOffsetTool(fakeViewport()));
  tool.start(new SketchPlane("XY"), (def) => written.push(def));
  return { held: () => inner(tool).value, written: () => written };
}

function pressPull(name: "value" | "taper", drag: number): Opened {
  const vp = fakeViewport();
  const { store, written } = fakeStore();
  const tool = track(new PressPullTool(vp, store));
  let over = true;
  Object.assign(tool, { hitGizmo: () => over, hitTaper: () => false });
  tool.start(() => {});
  dragHandle(vp.domElement, drag);
  over = false;
  return { held: () => inner(tool)[name], written: () => written.map(pickOf("distance", "taper")) };
}

function extrude(name: "taper"): Opened {
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const area = {
    sketchId: "s1",
    interior3D: new THREE.Vector3(0, 0, 0),
    plane: { n: new THREE.Vector3(0, 0, 1), plane, to2D: () => new THREE.Vector2(), to3D: () => new THREE.Vector3() },
    region: { loop: [] },
  };
  let selected: unknown[] = [area];
  const overlay = lenient({
    regions: [],
    selectedRegions: () => selected,
    clearRegionSelection: () => {
      selected = [];
    },
  });
  const vp = fakeViewport();
  const { store, written } = fakeStore();
  const tool = track(new ExtrudeTool(vp, overlay as never, store));
  let over = true;
  Object.assign(tool, {
    hitGizmo: () => over,
    hitTaper: () => false,
    positionDim: () => {},
    syncPeek: () => {},
    updatePrism: () => {},
  });
  tool.start(() => {});
  dragHandle(vp.domElement, 30);
  over = false;
  return {
    held: () => inner(tool)[name],
    written: () => written.map(pickOf("distance", "taper")),
    pointerMoved: () => (tool as unknown as { updatePreview(): void }).updatePreview(),
  };
}

function sketchCircularPattern(): Opened {
  const dim = new DimInput();
  const patterns: { angle?: unknown }[] = [];
  const host: PatternHost = {
    tool: () => "patternCircular",
    setActiveTool() {},
    setTool() {},
    selected: () => new Set(["l1"]),
    patterns: () => patterns as never,
    dim: () => dim,
    sourcePoint: () => null,
    requestSolve() {},
    toScreen: () => null,
    showCentreDot() {},
    refreshActive() {},
    onState() {},
  };
  const flow = new PatternFlow(host);
  flow.click(new THREE.Vector2(3, 2));
  opened.push({ active: true, cancel: () => dim.hide() } as Internals);
  return {
    held: () => (flow.pending as { angle?: unknown } | null)?.angle,
    written: () => patterns.map((p) => p.angle),
  };
}

const field = (name: string) => document.querySelector<HTMLInputElement>(`.dim-field[data-field="${name}"] input`)!;

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
  for (const tool of opened.splice(0)) if (tool.active) tool.cancel();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("a field undo in a tool holding its own value", () => {
  it.each<[string, string, () => Opened, unknown[]]>([
    ["joint offset", "offset", () => joint("offset"), [["j1", { offset: 3, angle: 20 }]]],
    ["joint angle", "angle", () => joint("angle"), [["j1", { offset: 3, angle: 20 }]]],
    ["mechanism drive", "offset", mechanism, []],
    ["thread pitch", "pitch", () => thread("pitch"), [{ type: "thread", pitch: 1.5, length: undefined }]],
    ["thread length", "length", () => thread("length"), [{ type: "thread", pitch: 1.5, length: undefined }]],
    ["text on face depth", "depth", textOnFace, [{ type: "textOnFace", depth: 1 }]],
    ["datum pose offset", "offset", () => datumPose("offset"), []],
    ["datum pose tilt X", "tiltX", () => datumPose("tiltX"), []],
    ["datum pose tilt Y", "tiltY", () => datumPose("tiltY"), []],
    ["datum pose spin", "spin", () => datumPose("spin"), []],
    ["plane offset", "offset", planeOffset, [{ origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] }]],
    [
      "press pull distance after an outward drag",
      "distance",
      () => pressPull("value", 30),
      [{ distance: 3, taper: undefined }],
    ],
    [
      "press pull distance after an inward drag",
      "distance",
      () => pressPull("value", -30),
      [{ distance: -3, taper: undefined }],
    ],
    ["press pull taper", "taper", () => pressPull("taper", 30), [{ distance: 3, taper: undefined }]],
    ["extrude taper", "taper", () => extrude("taper"), [{ distance: 13, taper: undefined }]],
    ["sketch circular pattern angle", "angle", sketchCircularPattern, [360]],
  ])("%s goes back to the value it held, and Enter commits it", (_what, name, open, written) => {
    const tool = open();
    flushFrame();
    const input = field(name);
    const shown = input.value;
    const before = tool.held();

    typeInto(input, "7");
    flushFrame();
    tool.pointerMoved?.();
    expect(tool.held()).not.toEqual(before);

    typeInto(input, shown, "historyUndo");
    expect([input.value, tool.held()]).toEqual([shown, before]);
    flushFrame();
    tool.pointerMoved?.();
    expect([input.value, tool.held()]).toEqual([shown, before]);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(tool.written()).toEqual(written);
  });
});
