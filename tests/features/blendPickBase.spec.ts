// A Fillet or Chamfer open on a box picks its edges on the model before the feature, never on the rounded preview,
// and one session writes one feature with every edge clicked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { EdgeFeatureTool } from "../../src/features/edgeFeatureTool";
import { rimPrompt } from "../../src/features/blendPick";
import { screenPolylineDist } from "../../src/features/blendPick";
import { edgeSelectorFrom } from "../../src/viewport/edgeMatch";
import { usePromptStore } from "../../src/stores/prompt";
import type { DocumentStore } from "../../src/document/store";
import type { EdgeRef } from "../../src/viewport/edgeLines";
import type { Viewport } from "../../src/viewport/viewport";
import type { Feature, Selector } from "../../src/types";

function lenient<T extends object>(own: Record<string, unknown>): T {
  return new Proxy(own, {
    get: (t, k) => (k in t ? t[k as string] : () => undefined),
  }) as unknown as T;
}

type P = [number, number, number];
const line = (id: string, a: P, b: P, slot: number) =>
  ({ id, body: "b1", points: [a, b], smooth: false, slot }) as unknown as EdgeRef;

// The top of a 20 by 20 box at z 10, seen from above: x and y map straight to the screen, 10 px per mm.
const A = line("a", [-10, -10, 10], [10, -10, 10], 0);
const B = line("b", [10, -10, 10], [10, 10, 10], 1);
const C = line("c", [10, 10, 10], [-10, 10, 10], 2);
const D = line("d", [-10, 10, 10], [-10, -10, 10], 3);
const BASE_LINES = [A, B, C, D];
// The preview with A rounded: its rim, and B trimmed back to where the round ends.
const RIM = line("rim", [-10, -8, 10], [10, -8, 10], 0);
const B_TRIMMED = line("b2", [10, -8, 10], [10, 10, 10], 1);
const RESULT_LINES = [RIM, B_TRIMMED, C, D];

const screen = (p: readonly number[]) => ({ x: 300 + p[0]! * 10, y: 300 - p[1]! * 10 });
const midOnScreen = (l: EdgeRef) => {
  const [a, b] = l.points as P[];
  return screen([(a![0] + b![0]) / 2, (a![1] + b![1]) / 2]);
};
const sel = (l: EdgeRef) => edgeSelectorFrom({ points: l.points as P[], body: "b1" }) as Selector & { point: P };

function rig(features: Feature[] = [], baseLines: EdgeRef[] = BASE_LINES) {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 500);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const BASE = { tag: "base" };
  const released: unknown[] = [];
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
  const vp = lenient<Viewport>({
    domElement: document.createElement("canvas"),
    camera,
    suspendPicking: false,
    selectedEdgeSeeds: () => [{ sel: sel(A), line: A }],
    selectedEdgeScope: () => ({ scope: "single" }),
    selectedEdgeCount: () => 1,
    edgeScopeView: () => ({ edgePx: 20, viewportPx: 800, pixelWorldSize: 0.1, modelDiagonal: 30 }),
    pixelWorldSize: () => 0.1,
    projectToScreen: (v: THREE.Vector3) => screen([v.x, v.y]),
    modelDiagonal: () => 30,
    snapStep: () => 0.5,
    holdModel: () => BASE,
    releaseModel: (v: unknown) => released.push(v),
    pickEdgeAt: (x: number, y: number, view?: unknown) => pickIn(view === BASE ? baseLines : RESULT_LINES, x, y),
    visibleEdgeLines: (view?: unknown) => (view === BASE ? baseLines : RESULT_LINES),
    edgeLineByMid: (mid: P, view?: unknown) => byMid(view === BASE ? baseLines : RESULT_LINES, mid),
    edgeLineForSelector: (point: P) => byMid(baseLines, point),
    rayFrom: () => new THREE.Raycaster(new THREE.Vector3(0, 0, 500), new THREE.Vector3(0, 0, -1)),
  });
  const added: Feature[] = [];
  const edits: { id: string; feature: Feature | null }[] = [];
  let built: ((s: unknown) => void) | null = null;
  let n = 0;
  const store = lenient<DocumentStore>({
    document: { features, parameters: {} },
    nextId: () => `f${++n}`,
    addFeature: (f: Feature) => added.push(f),
    commitFeatureEdit: (id: string, feature: Feature | null) => void edits.push({ id, feature }),
    onBuild: (fn: (s: unknown) => void) => {
      built = fn;
      return () => {};
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
  /** Opens from the edge handle, drags out 2 mm and lets go, as a grab of the selection handle does. */
  const openFromHandle = (kind: "fillet" | "chamfer" = "fillet") => {
    over = true;
    tool.start(kind, () => {}, { grabAt: { x: 0, y: 0 } });
    pointer("pointermove", 0, 20);
    vi.advanceTimersByTime(500);
    pointer("pointerup", 0, 20);
    over = false;
  };
  const rollback = () => built?.({ building: false, result: { bbox: null }, previewBuilt: [] });
  const enter = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  return { tool, click, openFromHandle, rollback, enter, added, edits, released, BASE };
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

describe("a fillet opened from the edge handle on a box", () => {
  it("adds the edge of the model before the fillet, not the trimmed one on screen", () => {
    const t = rig();
    open = t.tool;
    t.openFromHandle();
    t.click(midOnScreen(B));
    t.enter();
    expect(t.added).toHaveLength(1);
    expect(edgesOf(t.added[0])).toEqual([sel(A), sel(B)]);
  });

  it("takes two more edges, drops one, and Enter writes one feature with the base edges clicked", () => {
    const t = rig();
    open = t.tool;
    t.openFromHandle();
    t.click(midOnScreen(B));
    t.click(midOnScreen(C));
    expect(prompt()).toContain("Fillet, 3 edges");
    t.tool.removeMemberByKey("m2");
    expect(prompt()).toContain("Fillet, 2 edges");
    expect(t.added).toEqual([]);
    t.enter();
    expect(t.added).toHaveLength(1);
    expect(t.added[0]!.type).toBe("fillet");
    expect(edgesOf(t.added[0])).toEqual([sel(A), sel(C)]);
    expect(t.tool.active).toBe(false);
    expect(t.released).toEqual([t.BASE]);
  });

  it("keeps each row's name when an earlier row goes", () => {
    const t = rig();
    open = t.tool;
    t.openFromHandle();
    t.click(midOnScreen(B));
    t.click(midOnScreen(C));
    t.tool.removeMemberByKey("m2");
    t.click(midOnScreen(D));
    expect(t.tool.memberRows().map((r) => r.label)).toEqual(["Edge 1", "Edge 3", "Edge 4"]);
  });

  it("refuses a click on the round's own rim in words and adds nothing", () => {
    const t = rig();
    open = t.tool;
    t.openFromHandle("chamfer");
    t.click(midOnScreen(RIM));
    expect(prompt()).toBe("That edge comes from this chamfer, click an edge of the model before it · Esc");
    expect(t.tool.memberRows()).toHaveLength(1);
    expect(rimPrompt("fillet")).toBe("That edge comes from this fillet, click an edge of the model before it · Esc");
  });

  it("keeps the No edge there prompt for a real miss", () => {
    const t = rig();
    open = t.tool;
    t.openFromHandle();
    t.click({ x: 300, y: 300 });
    expect(prompt()).toMatch(/^No edge there, 1 edge kept/);
  });

  it("starts a new feature for a second session, the first is not reopened", () => {
    const t = rig();
    open = t.tool;
    t.openFromHandle();
    t.enter();
    t.openFromHandle();
    t.enter();
    expect(t.added.map((f) => f.id)).toEqual(["f1", "f2"]);
  });
});

describe("a fillet edited from History", () => {
  const saved = (edges: Selector | Selector[]): Feature[] => [
    { id: "box1", type: "box", length: 20, width: 20, height: 10 } as unknown as Feature,
    { id: "f9", type: "fillet", radius: 2, edges } as unknown as Feature,
  ];

  it("picks on the rolled back model and writes the one feature in place", () => {
    const t = rig(saved([sel(A)]));
    open = t.tool;
    expect(t.tool.startEdit("f9", () => {})).toBe(true);
    t.rollback();
    t.click(midOnScreen(B));
    t.click(midOnScreen(RIM));
    expect(prompt()).toMatch(/^That edge comes from this fillet/);
    t.enter();
    expect(t.added).toEqual([]);
    expect(t.edits).toHaveLength(1);
    expect(t.edits[0]!.id).toBe("f9");
    expect(edgesOf(t.edits[0]!.feature)).toEqual([sel(A), sel(B)]);
  });

  it("an old file's one bare selector opens, edits, and stays bare when the members come back the same", () => {
    const t = rig(saved(sel(A)));
    open = t.tool;
    expect(t.tool.startEdit("f9", () => {})).toBe(true);
    t.rollback();
    expect(t.tool.memberRows().map((r) => r.label)).toEqual(["Edge 1"]);
    t.click(midOnScreen(B));
    t.tool.removeMemberByKey("m2");
    t.enter();
    const written = t.edits.map((e) => edgesOf(e.feature)).filter((e) => e !== undefined);
    expect(written.every((e) => !Array.isArray(e))).toBe(true);
  });
});

// C runs on, tangent, into a quarter of a rounded corner: one click on C takes both while the switch is on.
const CORNER = line("corner", [-10, 10, 10], [-12, 9, 10], 4);
const C_RUN = line("c", [10, 10, 10], [-10, 10, 10], 2);
const TANGENT_LINES = [A, B, C_RUN, line("c2", [-10, 10, 10], [-30, 10, 10], 5), CORNER];

describe("Include tangent edges", () => {
  it("is on by default, a click takes the tangent run, and the written feature leaves the field out", () => {
    const t = rig([], TANGENT_LINES);
    open = t.tool;
    t.openFromHandle();
    expect(t.tool.includesTangentEdges()).toBe(true);
    t.click(midOnScreen(C_RUN));
    expect(t.tool.memberRows()).toHaveLength(3);
    expect(prompt()).toContain("Fillet, 3 edges");
    t.enter();
    expect(t.added[0]).not.toHaveProperty("tangentEdges");
    expect(edgesOf(t.added[0])).toHaveLength(3);
  });

  it("off, keeps only the edges clicked and writes tangentEdges false", () => {
    const t = rig([], TANGENT_LINES);
    open = t.tool;
    t.openFromHandle();
    t.click(midOnScreen(C_RUN));
    t.tool.setIncludeTangentEdges(false);
    expect(t.tool.memberRows()).toHaveLength(2);
    t.enter();
    expect(t.added[0]).toMatchObject({ tangentEdges: false, edges: [sel(A), sel(C_RUN)] });
  });

  it("back on, walks the runs of the edges clicked again", () => {
    const t = rig([], TANGENT_LINES);
    open = t.tool;
    t.openFromHandle();
    t.tool.setIncludeTangentEdges(false);
    t.click(midOnScreen(C_RUN));
    expect(t.tool.memberRows()).toHaveLength(2);
    t.tool.setIncludeTangentEdges(true);
    expect(t.tool.memberRows()).toHaveLength(3);
  });

  it("opens off for a saved feature that had it off, and keeps it off", () => {
    const t = rig([{ id: "f9", type: "fillet", radius: 2, edges: sel(A), tangentEdges: false } as unknown as Feature]);
    open = t.tool;
    t.tool.startEdit("f9", () => {});
    t.rollback();
    expect(t.tool.includesTangentEdges()).toBe(false);
  });
});
