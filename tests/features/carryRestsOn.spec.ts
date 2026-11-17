// A Press/Pull or Fillet started on a carried pick rests on the step it came from: undoing that step closes the tool,
// undoing any other leaves it, and a tool started without a step rests on nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { EdgeFeatureTool } from "../../src/features/edgeFeatureTool";
import { PressPullTool } from "../../src/features/pressPullTool";
import { closeToolOnLostStep } from "../../src/app/selection";
import { resetTreePicks } from "../../src/ui/treePick";
import type { Engine } from "../../src/app/engine";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";

const stand = vi.hoisted(() => ({ tools: [] as { active: boolean; cancel(): void }[] }));
vi.mock("../../src/app/toolBusy", () => ({
  cancelActiveTools: () => {
    for (const tool of stand.tools) if (tool.active) tool.cancel();
  },
}));

function lenient<T extends object>(own: Record<string, unknown>): T {
  return new Proxy(own, { get: (t, k) => (k in t ? t[k as string] : () => undefined) }) as unknown as T;
}

function rig() {
  const camera = new THREE.PerspectiveCamera();
  const viewport = lenient<Viewport>({
    domElement: document.createElement("canvas"),
    camera,
    suspendPicking: false,
    selectedEdgeSeeds: () => [],
    selectedFacesForPressPull: () => null,
    edgesOfSelectedFaces: () => [],
  });
  const listeners = new Set<(doc: unknown) => void>();
  let ids = ["b1", "f7", "f9"];
  const doc = () => ({ features: ids.map((id) => ({ id })) });
  const store = lenient<DocumentStore>({
    document: { features: [], parameters: {} },
    nextId: () => "f10",
    onBuild: () => () => {},
    onSessionBuild: () => () => {},
    isParamBound: () => false,
    bareParamRef: () => null,
    editPreviewId: null,
    onDocChange: (fn: (d: unknown) => void) => {
      listeners.add(fn);
      fn(doc());
      return () => listeners.delete(fn);
    },
  });
  const pressPull = new PressPullTool(viewport, store);
  const edgeFeature = new EdgeFeatureTool(viewport, store);
  stand.tools = [pressPull, edgeFeature];
  const e = {
    tools: { extrude: { active: false, profileSketches: [] }, pressPull, edgeFeature },
    toolAtWork: () => stand.tools.some((t) => t.active),
    store,
  } as unknown as Engine;
  closeToolOnLostStep(e);
  const remove = (...gone: string[]) => {
    ids = ids.filter((id) => !gone.includes(id));
    for (const fn of listeners) fn(doc());
  };
  return { pressPull, edgeFeature, remove };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  for (const tool of stand.tools) tool.cancel();
  resetTreePicks();
  vi.unstubAllGlobals();
});

describe("a tool started on a carried pick", () => {
  it("rests on the step it came from while it is open, and on nothing before and after", () => {
    const r = rig();
    expect(r.pressPull.dependsOn()).toEqual([]);
    expect(r.edgeFeature.dependsOn()).toEqual([]);
    r.pressPull.start(vi.fn(), { restsOn: "f7" });
    expect(r.pressPull.dependsOn()).toEqual(["f7"]);
    r.pressPull.cancel();
    expect(r.pressPull.dependsOn()).toEqual([]);
    r.edgeFeature.start("fillet", vi.fn(), { restsOn: "f9" });
    expect(r.edgeFeature.dependsOn()).toEqual(["f9"]);
    r.edgeFeature.cancel();
    expect(r.edgeFeature.dependsOn()).toEqual([]);
  });

  it("closes Press/Pull when undo removes its step, and leaves it for another step's removal", () => {
    const r = rig();
    r.pressPull.start(vi.fn(), { restsOn: "f7" });
    r.remove("f9");
    expect(r.pressPull.active).toBe(true);
    r.remove("f7");
    expect(r.pressPull.active).toBe(false);
  });

  it("closes Fillet when undo removes its step, and leaves it for another step's removal", () => {
    const r = rig();
    r.edgeFeature.start("fillet", vi.fn(), { restsOn: "f9" });
    r.remove("f7");
    expect(r.edgeFeature.active).toBe(true);
    r.remove("f9");
    expect(r.edgeFeature.active).toBe(false);
  });

  it("a tool started next without a step is not closed by the step the last one rested on", () => {
    const r = rig();
    r.pressPull.start(vi.fn(), { restsOn: "f7" });
    r.pressPull.cancel();
    r.pressPull.start(vi.fn());
    r.remove("f7");
    expect(r.pressPull.active).toBe(true);
    r.pressPull.cancel();
    r.edgeFeature.start("fillet", vi.fn(), { restsOn: "f9" });
    r.edgeFeature.cancel();
    r.edgeFeature.start("fillet", vi.fn());
    r.remove("f9");
    expect(r.edgeFeature.active).toBe(true);
  });
});
