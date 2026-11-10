// A face row from the Geometry list puts text on that face at the face's middle, and the panels open where that point is on screen.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { TextOnFaceTool } from "../../src/features/textOnFaceTool";
import { offerPicks, resetTreePicks, routeTreeClick, treePickWaiting, type NamedPick, type TreePick } from "../../src/ui/treePick";
import { useToolPanelStore } from "../../src/stores/toolPanels";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { PressPullFaces } from "../../src/viewport/faceAnalysis";
import type { FaceAnchorReply } from "../../src/geometry/client";
import type { Feature, Selector, Vec3 } from "../../src/types";

const FP = { surface: "cylinder", centroid: [3, -4, 5] };
const plane = (body = "body2"): FaceAnchorReply => ({ body, surface: "plane", at: [0.5, 0.5], normal: [0, 0, 1] });

type Ask = { sel: Selector; body: string | null; point: Vec3 };

// A row's face id i stands at (1.5 i, -2.25, 7) and projects to (30 i + 100, 277.5).
function rig(replies: Array<Promise<FaceAnchorReply | null>>, built = true) {
  const asked: Ask[] = [];
  const committed: Feature[][] = [];
  const viewport = {
    suspendPicking: false,
    domElement: document.createElement("canvas"),
    addToScene: () => {},
    removeFromScene: () => {},
    requestRender: () => {},
    clearHover: () => {},
    hoverFaceAt: () => null,
    pickFaceForPressPull: () => null,
    projectToScreen: (w: THREE.Vector3) => ({ x: w.x * 20 + 100, y: w.y * 10 + 300 }),
    facesForPressPull: (ids: readonly number[]): PressPullFaces | null =>
      built
        ? {
            selectors: ids.map((id) => ({ kind: "face", by: "nearest", point: [id, 2 * id, 7] }) as Selector),
            faceIds: [...ids],
            normal: new THREE.Vector3(0, 0, 1),
            anchor: new THREE.Vector3(ids[0]! * 1.5, -2.25, 7),
            bodyId: ids[0]! > 5 ? "body2" : "body1",
            round: null,
            lead: null,
          }
        : null,
  } as unknown as Viewport;
  const store = {
    nextId: () => "t1",
    boundExpr: () => null,
    setPreview: () => {},
    addFeatures: (f: Feature[]) => committed.push(f),
    faceAnchor: (sel: Selector, body: string | null, point: Vec3) => {
      asked.push({ sel, body, point });
      return replies.shift() ?? Promise.resolve(null);
    },
  } as unknown as DocumentStore;
  return { viewport, store, asked, committed };
}

const made: TextOnFaceTool[] = [];
function open(replies: Array<Promise<FaceAnchorReply | null>> = [], built = true) {
  const r = rig(replies, built);
  const done = vi.fn();
  const tool = new TextOnFaceTool(r.viewport, r.store);
  made.push(tool);
  tool.start(done);
  return { ...r, tool, done };
}

const hintsOf = () => {
  const said: string[] = [];
  return { said, busyHint: () => null, hint: (t: string) => said.push(t) };
};
const flush = () => new Promise((r) => setTimeout(r, 0));
const face = (faceId: number): TreePick => ({ kind: "face", faceId });
const panelAt = () => useToolPanelStore().text?.screen ?? null;
const commit = () =>
  useToolPanelStore().commitText({ text: "FUNDA", height: 6, style: "regular", align: "left", angle: 0 });

describe("Text on a face takes its face from a Geometry row", () => {
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

  it("asks the engine about the row's selector, body and stand point and commits the face it answers", async () => {
    const o = open([Promise.resolve(plane("body1"))]);
    expect(routeTreeClick(face(4), hintsOf())).toBe("taken");
    expect(o.asked).toEqual([
      { sel: { kind: "face", by: "nearest", point: [4, 8, 7] }, body: "body1", point: [6, -2.25, 7] },
    ]);
    await flush();
    commit();
    expect(o.committed).toHaveLength(1);
    expect(o.committed[0]![0]).toMatchObject({
      type: "textOnFace",
      text: "FUNDA",
      body: "body1",
      face: { kind: "face", by: "nearest", point: [6, -2.25, 7], body: "body1" },
      point: [6, -2.25, 7],
    });
    expect(o.done).toHaveBeenCalledWith("t1");
  });

  it("opens the panel at the projected point, on the far side of the canvas from it", async () => {
    open([Promise.resolve(plane("body1"))]);
    routeTreeClick(face(4), hintsOf());
    await flush();
    expect(panelAt()).toEqual({ x: window.innerWidth - 332, y: 157.5 });
    useToolPanelStore().text = null;

    const far = open([Promise.resolve(plane())]);
    routeTreeClick(face(16), hintsOf());
    await flush();
    expect(far.asked[0]!.point).toEqual([24, -2.25, 7]);
    expect(panelAt()).toEqual({ x: 16, y: 157.5 });
  });

  it("writes a round face by its fingerprint and fractions", async () => {
    const o = open([
      Promise.resolve({ body: "body2", surface: "cylinder", at: [0.25, 0.75], normal: [1, 0, 0], fp: FP }),
    ]);
    routeTreeClick(face(9), hintsOf());
    await flush();
    commit();
    expect(o.committed[0]![0]).toMatchObject({
      face: { kind: "face", by: "match", fp: FP, body: "body2" },
      at: [0.25, 0.75],
    });
  });

  it("a reason reply keeps the pick waiting for another row, which then places", async () => {
    const o = open([Promise.resolve({ reason: "no room" }), Promise.resolve(plane())]);
    routeTreeClick(face(4), hintsOf());
    await flush();
    expect([treePickWaiting(), o.tool.active, panelAt()]).toEqual([true, true, null]);
    expect(routeTreeClick(face(5), hintsOf())).toBe("taken");
    await flush();
    expect([o.asked.length, panelAt() !== null, treePickWaiting()]).toEqual([2, true, false]);
  });

  it("an engine with no answer and a sphere keep it waiting", async () => {
    const o = open([
      Promise.resolve(null),
      Promise.resolve({ body: "body1", surface: "sphere", at: [0.5, 0.5], normal: [0, 0, 1] }),
    ]);
    routeTreeClick(face(4), hintsOf());
    await flush();
    routeTreeClick(face(5), hintsOf());
    await flush();
    expect([o.asked.length, panelAt(), treePickWaiting(), o.tool.active]).toEqual([2, null, true, true]);
  });

  it("with two rows quickly, the later reply wins when the earlier arrives last", async () => {
    let late!: (r: FaceAnchorReply) => void;
    const first = new Promise<FaceAnchorReply>((res) => (late = res));
    const o = open([first, Promise.resolve(plane("body2"))]);
    routeTreeClick(face(4), hintsOf());
    routeTreeClick(face(8), hintsOf());
    await flush();
    late(plane("body1"));
    await flush();
    commit();
    expect(o.committed[0]![0]).toMatchObject({ body: "body2", point: [12, -2.25, 7] });
  });

  it("refuses a body, an edge and a half built model in words and keeps waiting", () => {
    const o = open();
    const d = hintsOf();
    const edge = { kind: "edge", edge: { body: "body1", points: [[1, 2, 3]] } } as unknown as TreePick;
    expect(routeTreeClick({ kind: "body", id: "body1" }, d)).toBe("refused");
    expect(routeTreeClick(edge, d)).toBe("refused");
    expect(d.said).toHaveLength(2);
    expect(d.said[0]).toMatch(/a body.*a face/);
    expect(d.said[1]).toMatch(/an edge.*a face/);
    expect([o.asked, treePickWaiting(), o.tool.active]).toEqual([[], true, true]);
    o.tool.cancel();

    const half = open([], false);
    expect(routeTreeClick(face(4), hintsOf())).toBe("refused");
    expect([half.asked, treePickWaiting()]).toEqual([[], true]);
  });

  it("is released once the text phase begins and on Escape, and a later tool has its own session", async () => {
    const o = open([Promise.resolve(plane())]);
    routeTreeClick(face(4), hintsOf());
    await flush();
    expect([treePickWaiting(), routeTreeClick(face(5), hintsOf())]).toEqual([false, "row"]);
    o.tool.cancel();

    const esc = open();
    expect(treePickWaiting()).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect([esc.tool.active, treePickWaiting(), esc.done.mock.calls]).toEqual([false, false, [[null]]]);

    const next = open([Promise.resolve(plane())]);
    expect(routeTreeClick(face(6), hintsOf())).toBe("taken");
    await flush();
    expect([esc.asked, next.asked.length]).toEqual([[], 1]);
  });
});

describe("Text on a face takes a row the brackets lit", () => {
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

  const edgeRow = { kind: "edge", edge: { body: "body1", points: [[1, 2, 3]] } } as unknown as TreePick;
  function offered(offers: NamedPick[]) {
    const said: string[] = [];
    const hints: string[] = [];
    offerPicks(offers, { busyHint: () => null, hint: (h) => hints.push(h), say: (w) => said.push(w) });
    return { said, hints };
  }

  it("a face starts the anchor ask for its selector and is spoken by name, once", async () => {
    const o = open([Promise.resolve(plane("body2"))]);
    const r = offered([{ pick: face(7), name: "Flat face 3 of Bracket" }]);
    expect(r.said).toEqual(["Flat face 3 of Bracket picked"]);
    expect(r.hints).toEqual([]);
    expect(o.asked).toEqual([
      { sel: { kind: "face", by: "nearest", point: [7, 14, 7] }, body: "body2", point: [10.5, -2.25, 7] },
    ]);
    await flush();
    commit();
    expect(o.committed[0]![0]).toMatchObject({ type: "textOnFace", body: "body2", point: [10.5, -2.25, 7] });
  });

  it("an edge is refused in words naming a face, nothing is asked and the tool still waits", () => {
    const o = open();
    const r = offered([{ pick: edgeRow, name: "Edge 2 of Bracket" }]);
    expect(r.said).toEqual([]);
    expect(r.hints).toHaveLength(1);
    expect(r.hints[0]).toMatch(/an edge.*a face/);
    expect([o.asked, treePickWaiting(), o.tool.active]).toEqual([[], true, true]);
  });

  it("a face then an edge speaks the face and refuses the edge in one hint", () => {
    const o = open([Promise.resolve(plane())]);
    const r = offered([
      { pick: face(5), name: "Flat face 1 of Bracket" },
      { pick: edgeRow, name: "Edge 2 of Bracket" },
    ]);
    expect(r.said).toEqual([]);
    expect(r.hints).toHaveLength(1);
    expect(r.hints[0]).toMatch(/^Flat face 1 of Bracket picked\. .*an edge.*a face/);
    expect(o.asked).toHaveLength(1);
  });

  it("a face while the model is still building is refused with the build words and nothing is asked", () => {
    const o = open([], false);
    const r = offered([{ pick: face(5), name: "Flat face 1 of Bracket" }]);
    expect(r.said).toEqual([]);
    expect(r.hints).toHaveLength(1);
    expect(r.hints[0]).toMatch(/building/);
    expect([o.asked, treePickWaiting()]).toEqual([[], true]);
  });

  it("a second tool after a pick has its own session and the first one's offers do not reach it", async () => {
    const first = open([Promise.resolve(plane())]);
    offered([{ pick: face(4), name: "Flat face 1 of Bracket" }]);
    await flush();
    first.tool.cancel();
    const second = open([Promise.resolve(plane("body2"))]);
    const r = offered([{ pick: face(8), name: "Flat face 2 of Bracket" }]);
    expect(r.said).toEqual(["Flat face 2 of Bracket picked"]);
    expect([first.asked.length, second.asked.length]).toEqual([1, 1]);
  });
});
