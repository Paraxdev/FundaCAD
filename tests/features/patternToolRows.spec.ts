// A face or edge row from the Geometry list gives a circular pattern its axis, as the engine finds it for that face or edge.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { PatternTool } from "../../src/features/patternTool";
import { resetTreePicks, routeTreeClick, treePickWaiting, type TreePick } from "../../src/ui/treePick";
import { usePromptStore } from "../../src/stores/prompt";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { EdgeRef } from "../../src/viewport/edgeLines";
import type { Selector, Vec3 } from "../../src/types";

type Reply = { axis: { origin: Vec3; dir: Vec3 } } | { reason: string } | null;

const BODY = new THREE.Box3(new THREE.Vector3(-5, -10, 0), new THREE.Vector3(5, 10, 5));

function rig(replies: Array<Promise<Reply>> = []) {
  const asked: Selector[] = [];
  const viewport = {
    suspendPicking: false,
    domElement: document.createElement("canvas"),
    addToScene: () => {},
    removeFromScene: () => {},
    bodiesCentroid: () => new THREE.Vector3(),
    facesCentroid: () => new THREE.Vector3(),
    bodiesBox: () => BODY.clone(),
    facesBox: () => BODY.clone(),
    setPatternGhost: () => {},
    setPatternFeatureGhost: () => {},
    clearPatternGhost: () => {},
    clearPatternFeatureGhost: () => {},
    hoverEntity: () => {},
    pixelWorldSize: () => 0.1,
    projectToScreen: () => ({ x: 0, y: 0 }),
    snapStep: () => 1,
    faceSelectorOf: (faceId: number) => ({
      kind: "face",
      by: "nearest",
      point: [faceId, 2 * faceId, 3],
      body: "body1",
    }),
  } as unknown as Viewport;
  const store = {
    nextId: () => "p1",
    addFeature: () => {},
    document: { features: [] },
    buildState: { result: { bodies: [{ id: "body1", name: "Body1", faceStart: 0, faceCount: 2, faceOwners: ["b"] }] } },
    patternAxis: (ref: Selector) => {
      asked.push(ref);
      return replies.shift() ?? Promise.resolve(null);
    },
  } as unknown as DocumentStore;
  return { viewport, store, asked };
}

const made: PatternTool[] = [];
function open(kind: "circular" | "linear" | "rect", replies: Array<Promise<Reply>> = []) {
  const r = rig(replies);
  const done = vi.fn();
  const tool = new PatternTool(r.viewport, r.store);
  made.push(tool);
  tool.start(kind, ["body1"], done);
  const inner = tool as unknown as { picked: { origin: Vec3; dir: Vec3; ref: Selector } | null; place: string };
  return {
    tool,
    done,
    inner,
    asked: r.asked,
    axis: () => (inner.picked ? { origin: inner.picked.origin, dir: inner.picked.dir } : null),
  };
}

const hintsOf = () => {
  const said: string[] = [];
  return { said, busyHint: () => null, hint: (t: string) => said.push(t) };
};
const flush = () => new Promise((r) => setTimeout(r, 0));
const face = (faceId: number): TreePick => ({ kind: "face", faceId });
const edge = (e: EdgeRef): TreePick => ({ kind: "edge", edge: e });
const edgeOf = (body: string, points: number[][]) => ({ body, points }) as unknown as EdgeRef;
const reply = (origin: Vec3, dir: Vec3): Reply => ({ axis: { origin, dir } });

describe("a circular pattern takes its axis from a face or edge row", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    for (const t of made.splice(0)) t.cancel();
    resetTreePicks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("asks the engine about the face row selector and turns about the axis it finds", async () => {
    const o = open("circular", [Promise.resolve(reply([13, -4, 2.5], [0, 0, -1]))]);
    expect([treePickWaiting(), o.inner.place, o.axis()]).toEqual([true, "origin", null]);
    expect(routeTreeClick(face(7), hintsOf())).toBe("taken");
    expect(o.asked).toEqual([{ kind: "face", by: "nearest", point: [7, 14, 3], body: "body1" }]);
    await flush();
    expect(o.inner.picked?.ref).toEqual(o.asked[0]);
    expect([o.inner.place, o.axis()]).toEqual(["picked", { origin: [13, -4, 2.5], dir: [0, 0, 1] }]);
  });

  it("asks about an edge row by the middle of the edge along its length, with its body", async () => {
    const o = open("circular", [Promise.resolve(reply([3, -2, 5], [1, 0, 0]))]);
    const bent = edgeOf("body2", [
      [3, -2, 5],
      [11, -2, 5],
      [11, 4, 5],
    ]);
    expect(routeTreeClick(edge(bent), hintsOf())).toBe("taken");
    expect(o.asked).toEqual([{ kind: "edge", by: "nearest", point: [10, -2, 5], body: "body2" }]);
    await flush();
    expect(o.axis()).toEqual({ origin: [3, -2, 5], dir: [1, 0, 0] });
  });

  it("shows the engine reason on the prompt, keeps the axis it had and keeps waiting", async () => {
    const o = open("circular", [
      Promise.resolve(reply([13, -4, 2.5], [0, 1, 0])),
      Promise.resolve({ reason: "That face has no axis" }),
    ]);
    routeTreeClick(face(7), hintsOf());
    await flush();
    routeTreeClick(face(8), hintsOf());
    await flush();
    expect(usePromptStore().text).toContain("That face has no axis");
    expect([o.axis(), o.inner.place, treePickWaiting()]).toEqual([
      { origin: [13, -4, 2.5], dir: [0, 1, 0] },
      "picked",
      true,
    ]);
  });

  it("with two rows quickly, the newer answer wins when the older arrives last", async () => {
    let late!: (r: Reply) => void;
    const first = new Promise<Reply>((res) => (late = res));
    const o = open("circular", [first, Promise.resolve(reply([1, 2, 3], [0, 1, 0]))]);
    routeTreeClick(face(7), hintsOf());
    routeTreeClick(face(9), hintsOf());
    await flush();
    late(reply([40, 50, 60], [1, 0, 0]));
    await flush();
    expect([o.asked.length, o.axis()]).toEqual([2, { origin: [1, 2, 3], dir: [0, 1, 0] }]);
  });

  it("refuses a body, a datum point and an edge with no points in words and keeps waiting", () => {
    const o = open("circular");
    const d = hintsOf();
    expect(routeTreeClick({ kind: "body", id: "body1" }, d)).toBe("refused");
    expect(routeTreeClick({ kind: "datumPoint", id: "p1", point: [1, 2, 3] }, d)).toBe("refused");
    expect(routeTreeClick(edge(edgeOf("body1", [])), d)).toBe("refused");
    expect(d.said).toHaveLength(3);
    expect(d.said[0]).toMatch(/a body.*a face or an edge/);
    expect(d.said[1]).toMatch(/a datum point/);
    expect([o.asked, treePickWaiting(), o.tool.active, o.done.mock.calls]).toEqual([[], true, true, []]);
  });

  it("registers no session for a linear or a rectangular pattern", () => {
    for (const kind of ["linear", "rect"] as const) {
      const o = open(kind);
      expect(treePickWaiting()).toBe(false);
      expect(routeTreeClick(face(7), hintsOf())).toBe("row");
      expect(o.asked).toEqual([]);
      o.tool.cancel();
    }
  });

  it("Escape closes the pattern and the session, and a pattern opened after it has its own", async () => {
    const first = open("circular", [Promise.resolve(reply([13, -4, 2.5], [0, 0, 1]))]);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect([first.tool.active, treePickWaiting(), first.done.mock.calls]).toEqual([false, false, [[null]]]);
    expect(routeTreeClick(face(7), hintsOf())).toBe("row");

    const second = open("circular", [Promise.resolve(reply([9, 8, 7], [1, 0, 0]))]);
    expect(routeTreeClick(face(5), hintsOf())).toBe("taken");
    await flush();
    expect([first.asked, second.asked.length, first.axis(), second.axis()]).toEqual([
      [],
      1,
      null,
      { origin: [9, 8, 7], dir: [1, 0, 0] },
    ]);
  });

  it("an answer arriving after the pattern closed changes nothing", async () => {
    let late!: (r: Reply) => void;
    const o = open("circular", [new Promise<Reply>((res) => (late = res))]);
    routeTreeClick(face(7), hintsOf());
    o.tool.cancel();
    late(reply([1, 1, 1], [0, 0, 1]));
    await flush();
    expect([o.tool.active, o.axis(), o.inner.place]).toEqual([false, null, "origin"]);
  });
});
