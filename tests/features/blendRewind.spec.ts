// An undo or a redo while Fillet or Chamfer is open: the tool stays, takes a fresh copy of the model before the
// feature, and drops the members whose edge that model no longer has.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { EdgeFeatureTool } from "../../src/features/edgeFeatureTool";
import { screenPolylineDist } from "../../src/features/blendPick";
import { edgeSelectorFrom } from "../../src/viewport/edgeMatch";
import { usePromptStore } from "../../src/stores/prompt";
import type { DocumentStore } from "../../src/document/store";
import type { EdgeRef } from "../../src/viewport/edgeLines";
import type { Viewport } from "../../src/viewport/viewport";
import type { Feature, Selector } from "../../src/types";

function lenient<T extends object>(own: Record<string, unknown>): T {
  return new Proxy(own, {
    get: (t, k) => (k in t ? Reflect.get(t, k) : () => undefined),
  }) as unknown as T;
}

type P = [number, number, number];
const line = (id: string, a: P, b: P, slot: number) =>
  ({ id, body: "b1", points: [a, b], smooth: false, slot }) as unknown as EdgeRef;

// The top of a 20 by 20 box at z 10, seen from above, 10 px per mm.
const A = line("a", [-10, -10, 10], [10, -10, 10], 0);
const B = line("b", [10, -10, 10], [10, 10, 10], 1);
const C = line("c", [10, 10, 10], [-10, 10, 10], 2);
const D = line("d", [-10, 10, 10], [-10, -10, 10], 3);
// An edge only the model after the rewind has, across the middle of the top.
const E = line("e", [-10, 0, 10], [10, 0, 10], 4);

const screen = (p: readonly number[]) => ({ x: 300 + p[0]! * 10, y: 300 - p[1]! * 10 });
const midOnScreen = (l: EdgeRef) => {
  const [a, b] = l.points as P[];
  return screen([(a![0] + b![0]) / 2, (a![1] + b![1]) / 2]);
};
const sel = (l: EdgeRef) => edgeSelectorFrom({ points: l.points as P[], body: "b1" }) as Selector & { point: P };

interface View {
  tag: string;
  lines: EdgeRef[];
}

function rig(opts: { features?: Feature[]; seed?: EdgeRef | null } = {}) {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 500);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const views: View[] = [{ tag: "open", lines: [A, B, C, D] }];
  let held = 0;
  const released: unknown[] = [];
  const pickedOn: unknown[] = [];
  const linesOf = (view?: unknown) => (view as View | undefined)?.lines ?? views[held - 1]?.lines ?? [];
  const pickIn = (lines: EdgeRef[], x: number, y: number) => {
    let best: { edge: EdgeRef; rankPx: number } | null = null;
    for (const l of lines) {
      const d = screenPolylineDist((l.points as P[]).map(screen), { x, y });
      if (d <= 8 && (!best || d < best.rankPx)) best = { edge: l, rankPx: d };
    }
    return best && { ...best, selector: sel(best.edge) };
  };
  const byMid = (lines: EdgeRef[], mid: readonly number[]) =>
    lines.find((l) => {
      const m = sel(l).point;
      return Math.hypot(m[0] - mid[0]!, m[1] - mid[1]!, m[2] - mid[2]!) < 1e-6;
    }) ?? null;
  const seed = opts.seed === undefined ? A : opts.seed;
  const vp = lenient<Viewport>({
    domElement: document.createElement("canvas"),
    camera,
    suspendPicking: false,
    selectedEdgeSeeds: () => (seed ? [{ sel: sel(seed), line: seed }] : []),
    edgesOfSelectedFaces: () => [],
    selectedEdgeScope: () => ({ scope: "single" }),
    selectedEdgeCount: () => (seed ? 1 : 0),
    edgeScopeView: () => ({ edgePx: 20, viewportPx: 800, pixelWorldSize: 0.1, modelDiagonal: 30 }),
    pixelWorldSize: () => 0.1,
    projectToScreen: (v: THREE.Vector3) => screen([v.x, v.y]),
    modelDiagonal: () => 30,
    snapStep: () => 0.5,
    holdModel: () => views[held++],
    heldDiff: () => ({ gone: [], fresh: [] }),
    addToScene: () => {},
    removeFromScene: () => {},
    releaseModel: (v: unknown) => released.push(v),
    pickEdgeAt: (x: number, y: number, view?: unknown) => {
      pickedOn.push(view);
      return pickIn(linesOf(view), x, y);
    },
    visibleEdgeLines: (view?: unknown) => linesOf(view),
    edgeLineByMid: (mid: P, view?: unknown) => byMid(linesOf(view), mid),
    edgeLineForSelector: (point: P) => byMid(linesOf(), point),
    rayFrom: () => new THREE.Raycaster(new THREE.Vector3(0, 0, 500), new THREE.Vector3(0, 0, -1)),
  });
  const previews: (Feature | null)[] = [];
  const editPreviews: (Feature | null)[] = [];
  let built: ((s: unknown) => void) | null = null;
  let rewind: (() => void) | null = null;
  let mark = 1;
  let n = 0;
  const doc = { features: opts.features ?? [], parameters: {} };
  const store = lenient<DocumentStore>({
    document: doc,
    nextId: () => `f${++n}`,
    setPreview: (f: Feature | null) => previews.push(f),
    setEditPreview: (f: Feature | null) => editPreviews.push(f),
    onBuild: (fn: (s: unknown) => void) => {
      built = fn;
      return () => (built = null);
    },
    onRewind: (fn: () => void) => {
      rewind = fn;
      return () => (rewind = null);
    },
    get undoMark() {
      return mark;
    },
    isParamBound: () => false,
    bareParamRef: () => null,
    buildState: { building: false, result: null },
  });
  const tool = new EdgeFeatureTool(vp, store);
  let over = false;
  Object.assign(tool, { hitGizmo: () => over, swipeProj: (_x: number, y: number) => y / 10, limit: () => Infinity });
  const canvas = vp.domElement;
  const pointer = (type: string, x: number, y: number) =>
    canvas.dispatchEvent(
      new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }),
    );
  const click = (at: { x: number; y: number }) => {
    pointer("pointerdown", at.x, at.y);
    pointer("pointerup", at.x, at.y);
  };
  const openFromHandle = () => {
    over = true;
    tool.start("fillet", () => {}, { grabAt: { x: 0, y: 0 } });
    pointer("pointermove", 0, 20);
    vi.advanceTimersByTime(500);
    pointer("pointerup", 0, 20);
    over = false;
  };
  const land = (previewBuilt: Feature[] | null) => built?.({ building: false, result: { bbox: null }, previewBuilt });
  /** The store tells its listeners before it swaps the document, the build of the new one lands later. */
  const rewindTo = async (lines: EdgeRef[], way: "undo" | "redo" = "undo") => {
    views.push({ tag: `after ${way}`, lines });
    rewind?.();
    if (way === "redo") mark++;
    await Promise.resolve();
  };
  return {
    tool,
    click,
    openFromHandle,
    land,
    rewindTo,
    views,
    released,
    pickedOn,
    previews,
    editPreviews,
    doc,
  };
}

const prompt = () => usePromptStore().text ?? "";
const edgesOf = (f: Feature | null | undefined) => (f as { edges?: unknown } | null | undefined)?.edges;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
let open: EdgeFeatureTool | null = null;
afterEach(() => {
  if (open?.active) open.cancel();
  open = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("an undo while a fillet is open", () => {
  it("drops the member whose edge the undo removed, says how many, and stays open", async () => {
    const t = rig();
    open = t.tool;
    t.openFromHandle();
    t.click(midOnScreen(B));
    expect(t.tool.memberRows()).toHaveLength(2);
    await t.rewindTo([A, C, D]);
    // The preview is set aside so the next build is the model before the fillet.
    expect(t.previews.at(-1)).toBeNull();
    t.land(null);
    expect(t.tool.active).toBe(true);
    expect(t.tool.memberRows().map((r) => r.label)).toEqual(["Edge 1"]);
    expect(prompt()).toBe("Undo removed 1 edge from the fillet");
    expect([edgesOf(t.previews.at(-1))].flat()).toEqual([sel(A)]);
  });

  it("counts every member dropped, and closes nothing when all of them go", async () => {
    const t = rig();
    open = t.tool;
    t.openFromHandle();
    t.click(midOnScreen(B));
    await t.rewindTo([C, D]);
    t.land(null);
    expect(t.tool.active).toBe(true);
    expect(t.tool.memberRows()).toEqual([]);
    expect(prompt()).toBe("Undo removed 2 edges from the fillet");
    expect(t.previews.at(-1)).toBeNull();
  });

  it("keeps the members whose edges survive, releases the old copy, and says nothing", async () => {
    const t = rig();
    open = t.tool;
    t.openFromHandle();
    t.click(midOnScreen(B));
    t.click(midOnScreen(C));
    await t.rewindTo([A, B, C]);
    expect(t.released).toEqual([]);
    t.land(null);
    expect(t.tool.memberRows()).toHaveLength(3);
    expect(t.released).toEqual([t.views[0]]);
    expect(prompt()).toMatch(/^Fillet, 3 edges/);
    t.tool.cancel();
    expect(t.released).toEqual([t.views[0], t.views[1]]);
  });

  it("waits past a build that still carries the fillet", async () => {
    const t = rig();
    open = t.tool;
    t.openFromHandle();
    t.click(midOnScreen(B));
    const blend = t.previews.find((f) => f !== null)!;
    await t.rewindTo([A, C, D]);
    t.land([blend]);
    expect(t.tool.memberRows()).toHaveLength(2);
    expect(t.released).toEqual([]);
    t.land(null);
    expect(t.tool.memberRows()).toHaveLength(1);
  });

  it("picks on the new copy after the undo", async () => {
    const t = rig();
    open = t.tool;
    t.openFromHandle();
    await t.rewindTo([A, B, C, D, E]);
    t.land(null);
    t.pickedOn.length = 0;
    t.click(midOnScreen(E));
    expect(t.pickedOn.length).toBeGreaterThan(0);
    expect(t.pickedOn.every((v) => v === t.views[1])).toBe(true);
    expect(t.tool.memberRows()).toHaveLength(2);
  });

  it("before any edge is picked, picks on the new copy too", async () => {
    const t = rig({ seed: null });
    open = t.tool;
    t.tool.start("fillet", () => {});
    await t.rewindTo([A, E]);
    t.land(null);
    expect(t.released).toEqual([t.views[0]]);
    t.pickedOn.length = 0;
    t.click(midOnScreen(E));
    expect(t.pickedOn[0]).toBe(t.views[1]);
    expect(t.tool.memberRows()).toHaveLength(1);
  });
});

describe("a redo while a fillet is open", () => {
  it("keeps the members whose edges exist again and holds the fresh copy", async () => {
    const t = rig();
    open = t.tool;
    t.openFromHandle();
    t.click(midOnScreen(B));
    await t.rewindTo([A, B, C, D, E], "redo");
    t.land(null);
    expect(t.tool.memberRows()).toHaveLength(2);
    expect(t.released).toEqual([t.views[0]]);
    expect(prompt()).toMatch(/^Fillet, 2 edges/);
    t.pickedOn.length = 0;
    t.click(midOnScreen(E));
    expect(t.pickedOn[0]).toBe(t.views[1]);
  });

  it("names the redo when it is the one that removed an edge", async () => {
    const t = rig();
    open = t.tool;
    t.openFromHandle();
    t.click(midOnScreen(B));
    await t.rewindTo([B, C, D], "redo");
    t.land(null);
    expect(prompt()).toBe("Redo removed 1 edge from the fillet");
    expect(t.tool.active).toBe(true);
  });
});

describe("an undo while a fillet is edited from History", () => {
  const saved = (): Feature[] => [
    { id: "box1", type: "box", length: 20, width: 20, height: 10 } as unknown as Feature,
    { id: "f9", type: "fillet", radius: 2, edges: [sel(A), sel(B)] } as unknown as Feature,
  ];

  it("rolls back again, holds the new model before the fillet, and drops the lost member", async () => {
    const t = rig({ features: saved() });
    open = t.tool;
    expect(t.tool.startEdit("f9", () => {})).toBe(true);
    t.land([]);
    expect(t.tool.memberRows()).toHaveLength(2);
    await t.rewindTo([A, C, D]);
    expect(t.editPreviews.at(-1)).toBeNull();
    t.land([t.editPreviews.find((f) => f !== null)!]);
    expect(t.tool.memberRows()).toHaveLength(2);
    t.land([]);
    expect(t.tool.active).toBe(true);
    expect(t.tool.memberRows()).toHaveLength(1);
    expect(t.released).toEqual([t.views[0]]);
    expect(prompt()).toBe("Undo removed 1 edge from the fillet");
    expect([edgesOf(t.editPreviews.at(-1))].flat()).toEqual([sel(A)]);
  });

  it("closes when the undo took the fillet itself away", async () => {
    const t = rig({ features: saved() });
    open = t.tool;
    t.tool.startEdit("f9", () => {});
    t.land([]);
    t.doc.features = t.doc.features.filter((f) => f.id !== "f9");
    await t.rewindTo([A, B, C, D]);
    expect(t.tool.active).toBe(false);
    expect(t.released).toEqual([t.views[0]]);
  });
});
