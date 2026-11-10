// Fillet and Chamfer take edge rows from the Geometry list the way a plain click in the view takes an edge.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { EdgeFeatureTool } from "../../src/features/edgeFeatureTool";
import { t } from "../../src/i18n";
import {
  endPickSession,
  endRewoundPick,
  offerPicks,
  resetTreePicks,
  routeTreeClick,
  treePickWaiting,
  type TreePick,
} from "../../src/ui/treePick";
import { usePromptStore } from "../../src/stores/prompt";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import type { EdgeRef } from "../../src/viewport/edgeLines";
import type { Viewport } from "../../src/viewport/viewport";

const cap = vi.hoisted(() => ({ value: 5000, asked: [] as [string, number][] }));
vi.mock("../../src/features/edgeCountGate", async (actual) => ({
  ...(await actual<typeof import("../../src/features/edgeCountGate")>()),
  get EDGE_CAP() {
    return cap.value;
  },
  confirmEdgeCount: async (label: string, count: number) => (cap.asked.push([label, count]), false),
}));

function lenient<T extends object>(own: Record<string, unknown>): T {
  return new Proxy(own, {
    get: (t, k) => (k in t ? t[k as string] : () => undefined),
  }) as unknown as T;
}

type P = [number, number, number];

// Three edges of a slanted box corner, no two tangent, so each row is its own chain.
const LINES = [
  [
    [4, -3, 2],
    [24, -3, 7],
  ],
  [
    [24, -3, 7],
    [24, 12, 7],
  ],
  [
    [4, 12, 2],
    [4, -3, 2],
  ],
].map((points, i) => ({ id: `b2:${i}`, body: "b2", points: points as P[], smooth: false, slot: i }));
const edgeRow = (i: number): TreePick => ({ kind: "edge", edge: LINES[i] as unknown as EdgeRef });

// Three colinear slanted edges in one tangent chain, and a fourth leaving its end at a corner.
const CHAIN = [
  [
    [5, -2, 3],
    [11, 1, 6],
  ],
  [
    [11, 1, 6],
    [17, 4, 9],
  ],
  [
    [17, 4, 9],
    [23, 7, 12],
  ],
  [
    [23, 7, 12],
    [23, 15, 12],
  ],
].map((points, i) => ({ id: `b4:${i}`, body: "b4", points: points as P[], smooth: false, slot: i }));
const chainRow = (i: number): TreePick => ({ kind: "edge", edge: CHAIN[i] as unknown as EdgeRef });

// pixelWorldSize 0.1 is a detail view (pickScope.ts), where a pick takes its edge alone; 0.5 takes the chain.
function rig(lines: typeof LINES = LINES, pixelWorldSize = 0.1) {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, -100, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const vp = lenient<Viewport>({
    domElement: document.createElement("canvas"),
    camera,
    suspendPicking: false,
    selectedEdgeSeeds: () => [],
    selectedEdgeCount: () => 0,
    edgesOfSelectedFaces: () => [],
    edgeScopeView: () => ({ edgePx: 60, viewportPx: 800, pixelWorldSize, modelDiagonal: 500 }),
    pixelWorldSize: () => 0.1,
    projectToScreen: () => ({ x: 100, y: 100 }),
    modelDiagonal: () => 500,
    edgeLineForSelector: () => null,
    edgeLineByMid: () => null,
    visibleEdgeLines: () => lines,
    rayFrom: () => new THREE.Raycaster(new THREE.Vector3(0, -100, 0), new THREE.Vector3(0, 1, 0)),
  });
  let k = 0;
  const store = lenient<DocumentStore>({
    document: { features: [], parameters: {} },
    nextId: () => `f${++k}`,
    onBuild: () => () => {},
    isParamBound: () => false,
    bareParamRef: () => null,
  });
  const hints: string[] = [];
  const click = (pick: TreePick) => routeTreeClick(pick, { busyHint: () => null, hint: (t) => hints.push(t) });
  const offer = (pick: TreePick, name: string) => {
    const said: string[] = [];
    const refused: string[] = [];
    offerPicks([{ pick, name }], { busyHint: () => null, hint: (h) => refused.push(h), say: (w) => said.push(w) });
    return { said, refused };
  };
  return { tool: new EdgeFeatureTool(vp, store), click, hints, offer };
}

const doneSaid = (name: string, done: "added" | "takenOut") => ({
  said: [t("pick.done", { name, done })],
  refused: [],
});

describe("an edge row while Fillet waits", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    resetTreePicks();
    document.body.replaceChildren();
  });

  it("waits for rows only while the tool is open", () => {
    const { tool } = rig();
    expect(treePickWaiting()).toBe(false);
    tool.start("fillet", () => {});
    expect(treePickWaiting()).toBe(true);
    tool.cancel();
    expect(treePickWaiting()).toBe(false);
  });

  it("starts the blend on the first row and adds the next ones as members", () => {
    const { tool, click } = rig();
    tool.start("fillet", () => {});
    expect(tool.memberRows()).toEqual([]);
    expect(click(edgeRow(0))).toBe("taken");
    expect(tool.memberRows().map((m) => m.label)).toEqual(["Edge 1"]);
    expect(click(edgeRow(2))).toBe("taken");
    expect(click(edgeRow(1))).toBe("taken");
    expect(tool.memberRows().map((m) => m.label)).toEqual(["Edge 1", "Edge 2", "Edge 3"]);
    expect(treePickWaiting()).toBe(true);
    tool.cancel();
  });

  it("takes a member's row back out, as a click on its ghost does", () => {
    const { tool, click } = rig();
    tool.start("chamfer", () => {});
    click(edgeRow(0));
    click(edgeRow(1));
    expect(click(edgeRow(0))).toBe("taken");
    expect(tool.memberRows()).toHaveLength(1);
    expect(click(edgeRow(0))).toBe("taken");
    expect(tool.memberRows()).toHaveLength(2);
    tool.cancel();
  });

  it.each(["fillet", "chamfer"] as const)(
    "%s says it added the first edge, added a second, took the first out",
    (kind) => {
      const { tool, offer } = rig();
      tool.start(kind, () => {});
      expect(offer(edgeRow(0), "Line edge 1 of Slant")).toEqual(doneSaid("Line edge 1 of Slant", "added"));
      expect(offer(edgeRow(2), "Line edge 3 of Slant")).toEqual(doneSaid("Line edge 3 of Slant", "added"));
      expect(tool.memberRows()).toHaveLength(2);
      expect(offer(edgeRow(0), "Line edge 1 of Slant")).toEqual(doneSaid("Line edge 1 of Slant", "takenOut"));
      expect(tool.memberRows()).toHaveLength(1);
      expect(t("pick.done", { name: "E", done: "added" })).not.toBe(t("pick.done", { name: "E", done: "takenOut" }));
      tool.cancel();
    },
  );

  it.each(["fillet", "chamfer"] as const)("%s says how many edges a row's tangent chain added or took out", (kind) => {
    const { tool, offer } = rig(CHAIN, 0.5);
    const chainSaid = (name: string, done: "added" | "takenOut", n: number) => ({
      said: [t("pick.doneChain", { name, done, n })],
      refused: [],
    });
    tool.start(kind, () => {});
    expect(offer(chainRow(1), "Line edge 2 of Rail")).toEqual(chainSaid("Line edge 2 of Rail", "added", 3));
    expect(tool.memberRows()).toHaveLength(3);
    expect(offer(chainRow(3), "Line edge 4 of Rail")).toEqual(doneSaid("Line edge 4 of Rail", "added"));
    expect(offer(chainRow(2), "Line edge 3 of Rail")).toEqual(chainSaid("Line edge 3 of Rail", "takenOut", 3));
    expect(tool.memberRows()).toHaveLength(1);
    expect(offer(chainRow(0), "Line edge 1 of Rail")).toEqual(chainSaid("Line edge 1 of Rail", "added", 3));
    expect(tool.memberRows()).toHaveLength(4);
    expect(t("pick.doneChain", { name: "E", done: "added", n: 3 })).toMatch(/3/);
    tool.cancel();
  });

  it("zoomed in on an edge, a row takes that edge alone and says no chain", () => {
    const { tool, offer } = rig(CHAIN);
    tool.start("fillet", () => {});
    expect(offer(chainRow(1), "Line edge 2 of Rail")).toEqual(doneSaid("Line edge 2 of Rail", "added"));
    expect(offer(chainRow(2), "Line edge 3 of Rail")).toEqual(doneSaid("Line edge 3 of Rail", "added"));
    expect(offer(chainRow(1), "Line edge 2 of Rail")).toEqual(doneSaid("Line edge 2 of Rail", "takenOut"));
    expect(tool.memberRows()).toHaveLength(1);
    tool.cancel();
  });

  it("a face offered says nothing taken, only the refusal, before and after members exist", () => {
    const { tool, offer } = rig();
    tool.start("fillet", () => {});
    const face = offer({ kind: "face", faceId: 17 }, "Flat face 6 of Slant");
    expect(face.said).toEqual([]);
    expect(face.refused).toHaveLength(1);
    offer(edgeRow(1), "Line edge 2 of Slant");
    const again = offer({ kind: "face", faceId: 17 }, "Flat face 6 of Slant");
    expect([again.said, again.refused.length, tool.memberRows().length]).toEqual([[], 1, 1]);
    tool.cancel();
  });

  it.each(["fillet", "chamfer"] as const)("%s over the edge cap says none was added and keeps its members", (kind) => {
    const { tool, offer } = rig();
    cap.value = 2;
    cap.asked.length = 0;
    try {
      tool.start(kind, () => {});
      offer(edgeRow(0), "Line edge 1 of Slant");
      expect(offer(edgeRow(2), "Line edge 3 of Slant")).toEqual(doneSaid("Line edge 3 of Slant", "added"));
      const over = offer(edgeRow(1), "Line edge 2 of Slant");
      expect(over.said).toEqual([]);
      expect(over.refused).toEqual([t("pick.overCap")]);
      expect([tool.memberRows().length, cap.asked]).toEqual([2, [[kind === "fillet" ? "Fillet" : "Chamfer", 3]]]);
      expect(offer(edgeRow(0), "Line edge 1 of Slant")).toEqual(doneSaid("Line edge 1 of Slant", "takenOut"));
      expect(offer(edgeRow(1), "Line edge 2 of Slant")).toEqual(doneSaid("Line edge 2 of Slant", "added"));
      expect([tool.memberRows().length, cap.asked.length]).toEqual([2, 1]);
    } finally {
      cap.value = 5000;
      tool.cancel();
    }
  });

  it("refuses a face row in words and keeps the members", () => {
    const { tool, click, hints } = rig();
    tool.start("fillet", () => {});
    expect(click({ kind: "face", faceId: 17 })).toBe("refused");
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/face.*edge/);
    click(edgeRow(1));
    expect(click({ kind: "face", faceId: 17 })).toBe("refused");
    expect(tool.memberRows()).toHaveLength(1);
    tool.cancel();
  });

  it("stays open through an undo or a redo and still takes rows, as Edit, Undo keeps the tool", () => {
    const { tool, click } = rig();
    const backend = { rebuild: async () => ({ ok: false, error: { message: "stub" } }), onStatus: () => () => {} };
    const store = new DocumentStore(backend as unknown as GeometryBackend, { parameters: {}, features: [] });
    store.onRewind(endRewoundPick);
    store.addFeature({ id: "x", type: "box", length: 1, width: 1, height: 1 } as never);
    const done = vi.fn();
    tool.start("fillet", done);
    store.undo();
    store.redo();
    expect([tool.active, done.mock.calls.length, treePickWaiting()]).toEqual([true, 0, true]);
    expect(click(edgeRow(0))).toBe("taken");
    expect(tool.memberRows()).toHaveLength(1);
    tool.cancel();
  });

  it("tells Add edge's user a Geometry row also adds mid edit, while the start prompt keeps saying Click", () => {
    const { tool, click } = rig();
    const prompt = () => usePromptStore().text ?? "";
    tool.start("chamfer", () => {});
    expect([prompt().startsWith("Click an edge"), /Geometry list|row/i.test(prompt())]).toEqual([true, false]);
    click(edgeRow(1));
    tool.promptAddMember();
    expect(prompt()).toMatch(/Geometry list|row/i);
    expect(prompt()).toContain("chamfer");
    tool.cancel();
  });

  it("closes when another pick takes the rows, so it cannot outlive its wait", () => {
    const { tool } = rig();
    const done = vi.fn();
    tool.start("fillet", done);
    endPickSession();
    expect(done).toHaveBeenCalledExactlyOnceWith(null);
    expect(tool.active).toBe(false);
  });
});
