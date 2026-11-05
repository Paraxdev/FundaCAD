// A face or edge row from the Geometry list reaches Measure as a probe, the way a click on the same face or edge does.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { MeasureTool } from "../../src/features/measureTool";
import { resetTreePicks, routeTreeClick, treePickWaiting, type TreePick } from "../../src/ui/treePick";
import { useToolPanelStore } from "../../src/stores/toolPanels";
import type { Viewport } from "../../src/viewport/viewport";
import type { EdgeRef } from "../../src/viewport/edgeLines";

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

interface FaceFact {
  area: number;
  centroid: THREE.Vector3;
  normal: THREE.Vector3;
}
const FACES: Record<number, FaceFact> = {
  4: { area: 120.5, centroid: V(13.5, -4.25, 22), normal: V(0, 0.6, 0.8) },
  6: { area: 80.25, centroid: V(-9.25, 7.5, 40.5), normal: V(0.8, 0, 0.6) },
  9: { area: 33.75, centroid: V(31, 12.5, -6), normal: V(0, 0, 1) },
};
const triangleOf = (id: number) => {
  const c = FACES[id]!.centroid;
  return new THREE.Triangle(c.clone().add(V(-2, -1, 0)), c.clone().add(V(3, -1, 0.5)), c.clone().add(V(0, 4, 1)));
};

const edgeA = {
  body: "b2",
  points: [
    [-20, 3, 5.5],
    [-8, 11, 9.5],
    [-1, 16.5, 12.25],
  ],
} as unknown as EdgeRef;
const edgeB = {
  body: "b3",
  points: [
    [40, -9, 2],
    [47.5, -2.25, 15],
  ],
} as unknown as EdgeRef;
const face = (faceId: number): TreePick => ({ kind: "face", faceId });
const edge = (e: EdgeRef): TreePick => ({ kind: "edge", edge: e });

function rig() {
  const highlights: [number[], EdgeRef[]][] = [];
  const el = document.createElement("canvas");
  let hit: unknown = null;
  const vp = {
    suspendPicking: false,
    domElement: el,
    clearSelection: () => {},
    hoverEntity: () => {},
    setMeasureMarker: () => {},
    measureHighlight: (f: number[], l: EdgeRef[]) => highlights.push([f, l]),
    measureFace: (id: number) => FACES[id]!,
    faceTriangles: (id: number) => [triangleOf(id)],
    pickEntity: () => hit,
  };
  const click = (h: unknown) => {
    hit = h;
    el.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true, cancelable: true }));
  };
  return { vp: vp as unknown as Viewport, highlights, click };
}

const hintsOf = () => {
  const said: string[] = [];
  return { said, busyHint: () => null, hint: (t: string) => said.push(t) };
};
const readout = () => JSON.parse(JSON.stringify(useToolPanelStore().measure));
const asHit = (p: TreePick) => ({ ...p, selector: { kind: "x" } });

/** What the same picks make when they arrive as clicks in the view. */
function byClicks(picks: TreePick[]) {
  const r = rig();
  const tool = new MeasureTool(r.vp);
  tool.start();
  for (const p of picks) r.click(asHit(p));
  const out = { rows: readout(), last: r.highlights.at(-1) };
  tool.stop();
  resetTreePicks();
  return out;
}

function byRows(picks: TreePick[]) {
  const r = rig();
  const tool = new MeasureTool(r.vp);
  tool.start();
  const d = hintsOf();
  const routes = picks.map((p) => routeTreeClick(p, d));
  return { r, tool, d, routes, rows: readout(), last: r.highlights.at(-1) };
}

describe("Measure takes face and edge rows as probes", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    resetTreePicks();
    document.body.innerHTML = "";
  });

  it("with no row yet it asks for a pick and waits for rows", () => {
    const m = byRows([]);
    expect(m.rows).toEqual([{ k: "", v: "Pick a face or edge" }]);
    expect([m.last, treePickWaiting()]).toEqual([undefined, true]);
    m.tool.stop();
  });

  it.each([
    ["one face", [face(4)]],
    ["one edge", [edge(edgeA)]],
    ["a face then an edge", [face(6), edge(edgeB)]],
    ["an edge then a face", [edge(edgeA), face(9)]],
    ["two faces", [face(4), face(9)]],
    ["two edges", [edge(edgeA), edge(edgeB)]],
    ["three picks, the third starts over", [face(4), edge(edgeA), face(9)]],
    ["four picks, the fourth joins the third", [face(4), edge(edgeA), face(9), edge(edgeB)]],
  ])("%s give what the same clicks give", (_n, picks) => {
    const want = byClicks(picks);
    const m = byRows(picks);
    expect(m.routes).toEqual(picks.map(() => "taken"));
    expect(m.d.said).toEqual([]);
    expect({ rows: m.rows, last: m.last }).toEqual(want);
    expect(want.rows.length).toBeGreaterThan(1);
    m.tool.stop();
  });

  it("highlights exactly the faces and edges picked, and a third row starts over with itself", () => {
    const alone = byClicks([face(9)]);
    const m = byRows([face(4), edge(edgeA)]);
    expect(m.last).toEqual([[4], [edgeA]]);
    routeTreeClick(face(9), m.d);
    expect([m.r.highlights.at(-1), readout()]).toEqual([[[9], []], alone.rows]);
    m.tool.stop();
  });

  it("refuses a body, a plane and a datum row in words, keeps the probes and keeps waiting", () => {
    const m = byRows([face(4)]);
    const before = readout();
    const d = hintsOf();
    const refused: TreePick[] = [
      { kind: "body", id: "b2" },
      { kind: "bodies", ids: ["b2", "b3"] },
      { kind: "datumPoint", id: "p1", point: [1, 2, 3] },
    ];
    for (const p of refused) expect(routeTreeClick(p, d)).toBe("refused");
    expect(d.said).toEqual([
      "That row is a body, this step needs a face or an edge",
      "That row is a folder of bodies, this step needs a face or an edge",
      "That row is a datum point, this step needs a face or an edge",
    ]);
    expect([readout(), m.r.highlights.at(-1), treePickWaiting()]).toEqual([before, [[4], []], true]);
    m.tool.stop();
  });

  it("refuses an edge with no points and keeps the probes", () => {
    const m = byRows([face(4)]);
    const d = hintsOf();
    expect(routeTreeClick(edge({ body: "b2", points: [] } as unknown as EdgeRef), d)).toBe("refused");
    expect(d.said).toHaveLength(1);
    expect(m.r.highlights).toHaveLength(1);
    m.tool.stop();
  });

  it("a right click's Measure from here starts with one probe and takes the second from a row", () => {
    const want = byClicks([face(4), edge(edgeB)]).rows;
    const r = rig();
    const tool = new MeasureTool(r.vp);
    tool.startWith({ kind: "face", faceId: 4 } as never);
    expect(routeTreeClick(edge(edgeB), hintsOf())).toBe("taken");
    expect(readout()).toEqual(want);
    tool.stop();
  });

  it("Esc and stop release the session, and a second Measure starts with no probe and its own session", () => {
    const first = byRows([face(4), edge(edgeA)]);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect([first.tool.active, treePickWaiting(), useToolPanelStore().measure]).toEqual([false, false, null]);
    expect(routeTreeClick(face(6), hintsOf())).toBe("row");

    const want = byClicks([edge(edgeB)]).rows;
    const second = byRows([]);
    expect(second.rows).toEqual([{ k: "", v: "Pick a face or edge" }]);
    expect(routeTreeClick(edge(edgeB), hintsOf())).toBe("taken");
    expect(readout()).toEqual(want);
    second.tool.stop();
    expect(treePickWaiting()).toBe(false);
  });

  it("a second tool taking the pick session ends the first Measure", () => {
    const first = byRows([face(4)]);
    const second = byRows([]);
    expect([first.tool.active, second.tool.active]).toEqual([false, true]);
    second.tool.stop();
  });
});
