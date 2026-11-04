// A running tool's window capture listener hears a key before a focused list does, so each tool has to leave a list
// row's keys alone. Escape is the exception, it still cancels from a row.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { h } from "vue";
import Listbox from "../../src/components/ui/Listbox.vue";
import { DraftTool } from "../../src/features/draftTool";
import { HoleTool } from "../../src/features/holeTool";
import { ThreadTool } from "../../src/features/threadTool";
import { EdgeFeatureTool } from "../../src/features/edgeFeatureTool";
import { FaceOffsetTool, type FaceOffsetMode } from "../../src/features/faceOffsetTool";
import { MirrorTool } from "../../src/features/mirrorTool";
import { PatternTool } from "../../src/features/patternTool";
import { PressPullTool } from "../../src/features/pressPullTool";
import { TargetEditTool } from "../../src/features/targetEditTool";
import { SketchMode } from "../../src/sketch/sketchMode";
import { noKeyDraw } from "../sketch/keyDrawStub";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { Feature } from "../../src/types";

vi.mock("../../src/sketch/solver", () => ({
  SolverUnavailable: class extends Error {},
  initSolver: async () => false,
  solveSketch: async () => {
    throw new Error("no solver in this test");
  },
}));

enableAutoUnmount(afterEach);

const ROW_KEYS = ["Enter", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Tab", "[", "]"];

function listRow(): HTMLElement {
  const box = document.createElement("div");
  box.setAttribute("role", "listbox");
  box.innerHTML = `<div role="option" tabindex="0"><span>Face 3</span></div>`;
  document.body.append(box);
  return box.querySelector("span")!;
}

function press(target: EventTarget, key: string): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

const stopAfter: (() => void)[] = [];

interface Internals {
  gesture: { attach(): void; detach(): void };
}

function attachWith<T extends Internals>(tool: T, fields: object): void {
  Object.assign(tool, fields);
  tool.gesture.attach();
  stopAfter.push(() => tool.gesture.detach());
}

const canvasOnly = () => ({ domElement: document.createElement("canvas") }) as unknown as Viewport;

function fillet() {
  const heard = { commit: vi.fn(), cancel: vi.fn() };
  const tool = new EdgeFeatureTool(canvasOnly(), {} as DocumentStore) as unknown as Internals;
  attachWith(tool, { ...heard, phase: "drag" });
  return heard;
}

function mirror() {
  const heard = { commit: vi.fn(), set: vi.fn(), cancel: vi.fn() };
  const tool = new MirrorTool(canvasOnly(), {} as DocumentStore) as unknown as Internals;
  attachWith(tool, {
    ...heard,
    fields: { objects: ["body2"], line: { plane: "XZ" }, lineId: null, active: "objects" },
  });
  return heard;
}

function pattern() {
  const scene = new THREE.Scene();
  const box = new THREE.Box3(new THREE.Vector3(13, -24, 3), new THREE.Vector3(31, 9, 17));
  const viewport = {
    suspendPicking: false,
    domElement: document.createElement("canvas"),
    addToScene: (o: THREE.Object3D) => scene.add(o),
    removeFromScene: (o: THREE.Object3D) => scene.remove(o),
    bodiesCentroid: () => new THREE.Vector3(22, -7, 10),
    facesCentroid: () => new THREE.Vector3(22, -7, 10),
    bodiesBox: () => box.clone(),
    facesBox: () => box.clone(),
    setPatternGhost: () => {},
    setPatternFeatureGhost: () => {},
    clearPatternGhost: () => {},
    clearPatternFeatureGhost: () => {},
    hoverEntity: () => {},
    pixelWorldSize: () => 0.1,
    projectToScreen: () => ({ x: 0, y: 0 }),
    snapStep: () => 1,
  } as unknown as Viewport;
  const added: Feature[] = [];
  const store = {
    nextId: () => "p1",
    boundExpr: () => null,
    addFeature: (f: Feature) => added.push(f),
    document: { features: [] },
    buildState: { result: { bodies: [{ id: "body1", name: "Body1", faceStart: 4, faceCount: 2, faceOwners: ["b"] }] } },
  } as unknown as DocumentStore;
  const done = vi.fn();
  const tool = new PatternTool(viewport, store);
  tool.start("linear", ["body1"], done);
  stopAfter.push(() => tool.cancel());
  return { count: () => (tool as unknown as { count: number }).count, added, done };
}

function waitingForFace(make: (viewport: Viewport) => { start(done: () => void): void; cancel(): void }) {
  const viewport = {
    suspendPicking: false,
    domElement: document.createElement("canvas"),
    selectedFacesForPressPull: () => null,
    clearHover: () => {},
    clearPressPullGhost: () => {},
    setPeek: () => {},
  } as unknown as Viewport;
  const done = vi.fn();
  const tool = make(viewport);
  tool.start(done);
  stopAfter.push(() => tool.cancel());
  return done;
}

const previewStore = { setPreview: () => {} } as unknown as DocumentStore;
const pressPullWaiting = () => waitingForFace((vp) => new PressPullTool(vp, previewStore));
const draftWaiting = () => waitingForFace((vp) => new DraftTool(vp, previewStore));
const holeWaiting = () => waitingForFace((vp) => new HoleTool(vp, previewStore));
const threadWaiting = () => waitingForFace((vp) => new ThreadTool(vp, previewStore));
const offsetWaiting = (mode: FaceOffsetMode) =>
  waitingForFace((vp) => {
    const tool = new FaceOffsetTool(vp, previewStore);
    return { start: (done) => tool.start(mode, done), cancel: () => tool.cancel() };
  });

function sketch() {
  const heard = { enter: vi.fn(), switchField: vi.fn(), cancel: vi.fn(), setTool: vi.fn() };
  const s = Object.create(SketchMode.prototype) as { onKey(e: KeyboardEvent): void };
  Object.assign(s, {
    tool: "select",
    selected: new Set<string>(),
    splinePts: [],
    clickPts: [],
    base: null,
    arcStart: null,
    dim: { isActive: false, ownsTarget: () => false },
    dims: { deleteSelected: () => false },
    patternFlow: { hasPending: () => false },
    modifyFlow: { offsetting: false, filletArmed: false },
    mirrorFlow: { running: true, enter: heard.enter, switchField: heard.switchField, cancel: heard.cancel },
    dimFlow: { picking: false, plan: null },
    constraintTools: { hasPending: () => false },
    keyDraw: noKeyDraw,
    setTool: heard.setTool,
  });
  const listen = (e: KeyboardEvent) => s.onKey(e);
  window.addEventListener("keydown", listen, true);
  stopAfter.push(() => window.removeEventListener("keydown", listen, true));
  return heard;
}

const calls = (heard: Record<string, { mock: { calls: unknown[] } }>) =>
  Object.fromEntries(Object.entries(heard).map(([k, f]) => [k, f.mock.calls.length]));

describe("a list row's keys while a tool runs", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    for (const stop of stopAfter.splice(0)) stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("Fillet: Enter on a row commits nothing, on the page it commits, Escape on a row cancels", () => {
    const heard = fillet();
    const row = listRow();
    for (const key of ROW_KEYS) expect(press(row, key).defaultPrevented).toBe(false);
    expect(calls(heard)).toEqual({ commit: 0, cancel: 0 });
    press(document.body, "Enter");
    expect(calls(heard)).toEqual({ commit: 1, cancel: 0 });
    press(row, "Escape");
    expect(calls(heard)).toEqual({ commit: 1, cancel: 1 });
  });

  it("Mirror: Enter on a row commits nothing, on the page it commits, Escape on a row cancels", () => {
    const heard = mirror();
    const row = listRow();
    for (const key of ROW_KEYS) expect(press(row, key).defaultPrevented).toBe(false);
    expect(calls(heard)).toEqual({ commit: 0, set: 0, cancel: 0 });
    press(document.body, "Enter");
    expect(calls(heard)).toEqual({ commit: 1, set: 0, cancel: 0 });
    press(row, "Escape");
    expect(calls(heard)).toEqual({ commit: 1, set: 0, cancel: 1 });
  });

  it("Target edit: Enter on a row, in the command search or on a button commits nothing, on the page it commits", () => {
    const heard = { commit: vi.fn(), cancel: vi.fn() };
    const tool = Object.assign(Object.create(TargetEditTool.prototype) as TargetEditTool, { active: true }, heard);
    const listen = (e: KeyboardEvent) => (tool as unknown as { onKey(e: KeyboardEvent): void }).onKey(e);
    window.addEventListener("keydown", listen, true);
    stopAfter.push(() => window.removeEventListener("keydown", listen, true));
    const row = listRow();
    const search = document.createElement("input");
    search.setAttribute("role", "combobox");
    const button = document.createElement("button");
    document.body.append(search, button);
    for (const key of ROW_KEYS) expect(press(row, key).defaultPrevented).toBe(false);
    for (const at of [search, button]) expect(press(at, "Enter").defaultPrevented).toBe(false);
    expect(calls(heard)).toEqual({ commit: 0, cancel: 0 });
    press(document.body, "Enter");
    expect(calls(heard)).toEqual({ commit: 1, cancel: 0 });
    press(row, "Escape");
    expect(calls(heard)).toEqual({ commit: 1, cancel: 1 });
  });

  it("Pattern: a row's keys neither commit nor step the count, the same keys on the page do", () => {
    const { count, added } = pattern();
    const row = listRow();
    const start = count();
    for (const key of ROW_KEYS) press(row, key);
    vi.runAllTimers();
    expect({ count: count(), added: added.length }).toEqual({ count: start, added: 0 });
    press(document.body, "ArrowUp");
    press(document.body, "]");
    press(document.body, "ArrowDown");
    expect(count()).toBe(start + 1);
    press(document.body, "[");
    expect(count()).toBe(start);
    press(document.body, "Enter");
    vi.runAllTimers();
    expect(added.map((f) => f.id)).toEqual(["p1"]);
  });

  it("Pattern: Escape on a row cancels and adds nothing", () => {
    const { added, done } = pattern();
    press(listRow(), "Escape");
    vi.runAllTimers();
    expect({ added, calls: done.mock.calls }).toEqual({ added: [], calls: [[null]] });
  });

  it.each([
    ["Press/Pull", pressPullWaiting],
    ["Draft", draftWaiting],
    ["Hole", holeWaiting],
    ["Thread", threadWaiting],
    ["Offset Face", () => offsetWaiting("offsetFace")],
    ["Thicken", () => offsetWaiting("thicken")],
    ["Shell", () => offsetWaiting("shell")],
  ])("%s waiting for a face: Enter on a row commits nothing, Escape on a row cancels", (_name, waiting) => {
    const done = waiting();
    const row = listRow();
    for (const key of ROW_KEYS) expect(press(row, key).defaultPrevented).toBe(false);
    expect(done.mock.calls).toEqual([]);
    press(row, "Escape");
    expect(done.mock.calls).toEqual([[null]]);
  });

  it("a sketch: a row's Enter, Tab and letters reach no flow or tool, the same keys on the page do", () => {
    const heard = sketch();
    const row = listRow();
    for (const key of [...ROW_KEYS, "l"]) press(row, key);
    expect(calls(heard)).toEqual({ enter: 0, switchField: 0, cancel: 0, setTool: 0 });
    press(document.body, "Enter");
    press(document.body, "Tab");
    press(document.body, "l");
    expect(calls(heard)).toEqual({ enter: 1, switchField: 1, cancel: 0, setTool: 1 });
  });

  it("a sketch: Escape on a row still cancels", () => {
    const heard = sketch();
    press(listRow(), "Escape");
    expect(calls(heard)).toEqual({ enter: 0, switchField: 0, cancel: 1, setTool: 0 });
  });

  it("a real Listbox keeps its own keys under a running Pattern", () => {
    const { count, added, done } = pattern();
    const start = count();
    const onApply = vi.fn();
    const w = mount(Listbox<string>, {
      attachTo: document.body,
      props: {
        items: [
          { value: "f4", label: "Face 4" },
          { value: "f7", label: "Face 7" },
          { value: "f9", label: "Face 9" },
        ],
        modelValue: null,
        label: "Geometry",
        onApply,
      },
      slots: {
        option: (p: { item: { label: string }; attrs: object }) =>
          h("button", { type: "button", ...p.attrs }, p.item.label),
      },
    });
    const rows = w.findAll<HTMLElement>('[role="option"]').map((o) => o.element);
    rows[0]!.focus();
    press(rows[0]!, "ArrowRight");
    expect(document.activeElement).toBe(rows[1]);
    press(rows[1]!, "Enter");
    vi.runAllTimers();
    expect(onApply.mock.calls).toEqual([["f7"]]);
    expect({ count: count(), added: added.length, calls: done.mock.calls }).toEqual({
      count: start,
      added: 0,
      calls: [],
    });
    press(rows[1]!, "Escape");
    expect(done.mock.calls).toEqual([[null]]);
  });
});
