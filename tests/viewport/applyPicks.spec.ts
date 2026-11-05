// The list's way to select: real Highlighter and BodyEdges, only the camera and frame requests are stubbed.
import { describe, expect, it, vi } from "vitest";
import { bandIndex } from "../../src/viewport/faceBands";
import type { EdgeRef } from "../../src/viewport/edgeLines";
import { Highlighter } from "../../src/viewport/highlight";
import { Picker, type Hit, type PickMods, type PickRef } from "../../src/viewport/picking";
import { Viewport } from "../../src/viewport/viewport";
import type { ScopeView } from "../../src/viewport/pickScope";
import type { ModelView } from "../../src/viewport/render";
import { bodyMesh } from "./pickRig";

// Far enough out that a plain click takes a chain, near enough in that it takes one edge.
const FAR_VIEW: ScopeView = { edgePx: 12, viewportPx: 900, pixelWorldSize: 0.4, modelDiagonal: 90 };
const NEAR_VIEW: ScopeView = { edgePx: 880, viewportPx: 900, pixelWorldSize: 0.02, modelDiagonal: 90 };

function rig(opts: { view?: ScopeView; mode?: "faces" | "bodies"; policy?: "auto" | "faces" | "bodies" } = {}) {
  const b1 = bodyMesh("body1", 4, [
    {
      id: "e1",
      points: [
        [32.5, -17.5, 18.5],
        [49.5, -17.5, 18.5],
      ],
    },
    {
      id: "e2",
      points: [
        [49.5, -17.5, 18.5],
        [49.5, -8.5, 18.5],
      ],
    },
    {
      id: "e3",
      points: [
        [49.5, -8.5, 18.5],
        [32.5, -8.5, -4.5],
      ],
    },
  ]);
  const b2 = bodyMesh("body2", 10, [
    {
      id: "e4",
      points: [
        [-61, 22, 3],
        [-44, 29, 12],
      ],
    },
  ]);
  const model = { bodies: [b1, b2], edges: [] } as unknown as ModelView;
  const highlighter = new Highlighter(model);
  const vp = Object.create(Viewport.prototype) as Viewport;
  const onSelection = vi.fn();
  const onBodies = vi.fn();
  Object.assign(vp, {
    highlighter,
    model,
    picker: new Picker(),
    // Faces 1 and 3 of body1 are one split surface, the ids are 5 and 7.
    faceBands: bandIndex([{ faceStart: 4, faceCount: 6, faceBands: [[1, 3]] }]),
    selectPolicy: opts.policy ?? "auto",
    selectionMode: opts.mode ?? "faces",
    edgeScope: { scope: "chain", reason: "tangent" },
    edgeClick: null,
    faceClick: null,
    suspendPicking: false,
    streaming: false,
    outOfDate: false,
    requestRender: () => {},
    edgeScopeView: () => opts.view ?? FAR_VIEW,
    onSelectionChange: onSelection,
    onBodySelectionChange: onBodies,
  });
  const edge = (id: string): EdgeRef => [b1, b2].flatMap((b) => b.edges.refs).find((r) => r.id === id)!;
  const state = () => ({
    faces: [...highlighter.getSelectedFaces()].sort((a, b) => a - b),
    edges: highlighter
      .getSelectedEdges()
      .map((e) => e.id)
      .sort(),
    bodies: highlighter.getSelectedBodies(),
    scope: vp.selectedEdgeScope(),
    mode: vp.selecting,
  });
  return { vp, highlighter, b1, onSelection, onBodies, edge, state };
}

const face = (faceId: number): PickRef => ({ kind: "face", faceId });
const faceHit = (faceId: number) => ({ kind: "face", faceId, selector: {}, point: [1, 2, 3] }) as unknown as Hit;
const edgeHit = (edge: EdgeRef) => ({ kind: "edge", edge, selector: {} }) as unknown as Hit;

describe("applyPicks", () => {
  it("selects a face exactly as a plain click does", () => {
    const clicked = rig();
    clicked.vp.applyPick(faceHit(8), { additive: false, exact: false });
    const listed = rig();
    listed.vp.applyPicks([face(8)], { additive: false });
    expect(listed.state()).toEqual(clicked.state());
    expect(listed.state().faces).toEqual([8]);
  });

  it("selects an edge exactly as a Shift click does", () => {
    const clicked = rig();
    clicked.vp.applyPick(edgeHit(clicked.edge("e2")), { additive: false, exact: true });
    const listed = rig();
    listed.vp.applyPicks([{ kind: "edge", edge: listed.edge("e2") }], { additive: false });
    expect(listed.state()).toEqual(clicked.state());
    expect(listed.state().edges).toEqual(["e2"]);
  });

  it("adds exactly as a Ctrl click does, over what was there", () => {
    const mods: PickMods = { additive: true, exact: false };
    const clicked = rig();
    clicked.vp.applyPick(faceHit(11), { additive: false, exact: false });
    clicked.vp.applyPick(faceHit(5), mods);
    const listed = rig();
    listed.vp.applyPick(faceHit(11), { additive: false, exact: false });
    listed.vp.applyPicks([face(5)], { additive: true });
    expect(listed.state()).toEqual(clicked.state());
    expect(listed.state().faces).toEqual([5, 7, 11]);
  });

  it("replaces what was selected unless told to add", () => {
    const r = rig();
    r.vp.applyPick(faceHit(11), { additive: false, exact: false });
    r.vp.applyPicks([{ kind: "edge", edge: r.edge("e1") }], { additive: false });
    expect(r.state()).toMatchObject({ faces: [], edges: ["e1"] });
  });

  it("tells the app once, for no picks, one, or many", () => {
    const none = rig();
    none.vp.applyPicks([face(8)], { additive: false });
    none.onSelection.mockClear();
    none.vp.applyPicks([], { additive: true });
    expect({ calls: none.onSelection.mock.calls.length, faces: none.state().faces }).toEqual({ calls: 1, faces: [8] });

    const cleared = rig();
    cleared.vp.applyPicks([face(8)], { additive: false });
    cleared.onSelection.mockClear();
    cleared.vp.applyPicks([], { additive: false });
    expect({ calls: cleared.onSelection.mock.calls.length, faces: cleared.state().faces }).toEqual({
      calls: 1,
      faces: [],
    });

    const one = rig();
    one.vp.applyPicks([face(8)], { additive: false });
    expect(one.onSelection).toHaveBeenCalledTimes(1);

    const many = rig();
    many.vp.applyPicks(
      [face(8), face(9), face(12), { kind: "edge", edge: many.edge("e1") }, { kind: "edge", edge: many.edge("e4") }],
      { additive: false },
    );
    expect(many.onSelection).toHaveBeenCalledTimes(1);
    expect(many.state()).toMatchObject({ faces: [8, 9, 12], edges: ["e1", "e4"] });
  });

  it("takes a split face's whole run from either piece", () => {
    for (const piece of [5, 7]) {
      const r = rig();
      r.vp.applyPicks([face(piece)], { additive: false });
      expect(r.state().faces).toEqual([5, 7]);
    }
  });

  it("keeps a run on when one call names two of its pieces, and a ref named twice on", () => {
    const both = rig();
    both.vp.applyPicks([face(5), face(7)], { additive: false });
    expect(both.state().faces).toEqual([5, 7]);
    const twice = rig();
    twice.vp.applyPicks(
      [face(8), face(8), { kind: "edge", edge: twice.edge("e3") }, { kind: "edge", edge: twice.edge("e3") }],
      {
        additive: false,
      },
    );
    expect(twice.state()).toMatchObject({ faces: [8], edges: ["e3"] });
  });

  it("scopes an edge to itself at any zoom, where a plain click far out takes a chain", () => {
    const click = rig({ view: FAR_VIEW });
    click.vp.applyPick(edgeHit(click.edge("e1")), { additive: false, exact: false });
    expect(click.vp.selectedEdgeScope().scope).toBe("chain");
    const nearClick = rig({ view: NEAR_VIEW });
    nearClick.vp.applyPick(edgeHit(nearClick.edge("e1")), { additive: false, exact: false });
    expect(nearClick.vp.selectedEdgeScope()).toEqual({ scope: "single", reason: "zoom" });
    for (const view of [FAR_VIEW, NEAR_VIEW]) {
      const r = rig({ view });
      r.vp.applyPicks([{ kind: "edge", edge: r.edge("e1") }], { additive: false });
      expect(r.vp.selectedEdgeScope()).toEqual({ scope: "single", reason: "shift" });
    }
  });

  it("turns a selected face or edge off when adding, and leaves the rest", () => {
    const r = rig();
    r.vp.applyPicks([face(5), face(9), { kind: "edge", edge: r.edge("e1") }, { kind: "edge", edge: r.edge("e2") }], {
      additive: false,
    });
    expect(r.state()).toMatchObject({ faces: [5, 7, 9], edges: ["e1", "e2"] });
    r.vp.applyPicks([face(7), { kind: "edge", edge: r.edge("e2") }], { additive: true });
    expect(r.state()).toMatchObject({ faces: [9], edges: ["e1"] });
  });

  it("clears a body selection and leaves bodies mode", () => {
    const r = rig({ mode: "bodies" });
    r.highlighter.selectOnlyBody("body2");
    r.vp.applyPicks([face(8)], { additive: true });
    expect(r.state()).toMatchObject({ faces: [8], bodies: [], mode: "faces" });
    expect(r.onBodies).toHaveBeenCalledTimes(1);
    expect(r.onSelection).toHaveBeenCalledTimes(1);
  });

  it("says nothing about bodies when already in faces mode", () => {
    const r = rig({ mode: "faces" });
    r.vp.applyPicks([face(8)], { additive: false });
    expect(r.onBodies).not.toHaveBeenCalled();
  });

  it("leaves a Bodies policy for the caller's action to change", () => {
    const r = rig({ mode: "bodies", policy: "bodies" });
    r.vp.applyPicks([face(8)], { additive: false });
    expect({ policy: r.vp.policy, mode: r.vp.selecting }).toEqual({ policy: "bodies", mode: "faces" });
  });

  it.each([false, true])("drops the last click's points, additive %s", (additive) => {
    const r = rig();
    const clicked = r.edge("e1");
    r.vp.applyPick(edgeHit(clicked), { additive: false, exact: true });
    Object.assign(r.vp, { faceClick: [3, 4, 5], edgeClick: { edge: clicked, at: [33, -17.5, 18.5] } });
    expect(r.vp.selectedEdgeClickPoint()).toEqual([33, -17.5, 18.5]);
    r.vp.applyPicks([face(8)], { additive });
    const held = r.vp as unknown as { faceClick: unknown; edgeClick: unknown };
    expect({ face: held.faceClick, edge: held.edgeClick }).toEqual({ face: null, edge: null });
    expect(r.vp.selectedEdgeClickPoint()).toBeNull();
  });

  it("still tells the app with no model drawn", () => {
    const r = rig();
    Object.assign(r.vp, { highlighter: null, model: null });
    r.vp.applyPicks([face(8)], { additive: false });
    expect(r.onSelection).toHaveBeenCalledTimes(1);
  });
});

describe("applyPick after sharing its step", () => {
  it("takes one piece of a run on a Shift click and the whole run on a plain one", () => {
    const shift = rig();
    shift.vp.applyPick(faceHit(7), { additive: false, exact: true });
    expect(shift.state().faces).toEqual([7]);
    const plain = rig();
    plain.vp.applyPick(faceHit(7), { additive: false, exact: false });
    expect(plain.state().faces).toEqual([5, 7]);
  });

  it("clears on a click on nothing, keeps on a Ctrl click on nothing, and tells the app each time", () => {
    const r = rig();
    r.vp.applyPick(faceHit(9), { additive: false, exact: false });
    r.onSelection.mockClear();
    r.vp.applyPick(null, { additive: true, exact: false });
    expect(r.state().faces).toEqual([9]);
    r.vp.applyPick(null, { additive: false, exact: false });
    expect(r.state().faces).toEqual([]);
    expect(r.onSelection).toHaveBeenCalledTimes(2);
  });

  it("leaves the mode and the click's point alone, those belong to the click", () => {
    const r = rig({ mode: "bodies" });
    Object.assign(r.vp, { faceClick: [3, 4, 5] });
    r.vp.applyPick(faceHit(9), { additive: true, exact: false });
    expect((r.vp as unknown as { faceClick: unknown }).faceClick).toEqual([3, 4, 5]);
    expect(r.vp.selecting).toBe("bodies");
  });
});

describe("hoverPick", () => {
  function hovered() {
    const r = rig();
    const emphasised = vi.fn();
    Object.assign(r.vp, { emphasiseEdges: emphasised });
    return { ...r, emphasised };
  }

  it("hatches a split face's whole run, lights no edge and leaves canvas hover empty", () => {
    const r = hovered();
    r.vp.hoverPick(face(7));
    expect(r.highlighter.litFaceIds()).toEqual([5, 7]);
    expect(r.highlighter.hoverState()).toEqual({ body: null, edge: null, faces: [] });
    expect(r.emphasised.mock.calls).toEqual([[[]]]);
  });

  it("lights one plain face", () => {
    const r = hovered();
    r.vp.hoverPick(face(9));
    expect(r.highlighter.litFaceIds()).toEqual([9]);
  });

  it("lights an edge and draws it over the model, replacing a lit face", () => {
    const r = hovered();
    r.vp.hoverPick(face(9));
    r.emphasised.mockClear();
    const e = r.edge("e3");
    r.vp.hoverPick({ kind: "edge", edge: e });
    expect(r.highlighter.hoverState()).toEqual({ body: null, edge: e, faces: [] });
    expect(r.highlighter.litFaceIds()).toEqual([]);
    expect(r.emphasised.mock.calls).toEqual([[[e]]]);
  });

  it("clears on null", () => {
    const r = hovered();
    r.vp.hoverPick({ kind: "edge", edge: r.edge("e3") });
    r.emphasised.mockClear();
    r.vp.hoverPick(null);
    expect(r.highlighter.hoverState()).toEqual({ body: null, edge: null, faces: [] });
    expect(r.emphasised.mock.calls).toEqual([[[]]]);
  });

  it("selects nothing and tells nobody", () => {
    const r = hovered();
    r.vp.hoverPick(face(9));
    expect(r.state().faces).toEqual([]);
    expect(r.onSelection).not.toHaveBeenCalled();
  });
});

describe("bodyEdgeRefs", () => {
  const ids = (refs: EdgeRef[]) => refs.map((e) => e.id);

  it("gives the edges of that body only, in wire order", () => {
    const r = rig();
    expect(ids(r.vp.bodyEdgeRefs("body1"))).toEqual(["e1", "e2", "e3"]);
    expect(ids(r.vp.bodyEdgeRefs("body2"))).toEqual(["e4"]);
    expect(r.vp.bodyEdgeRefs("body1").map((e) => e.slot)).toEqual([0, 1, 2]);
  });

  it("gives none for a hidden body, an unknown body or no model", () => {
    const r = rig();
    expect(r.vp.bodyEdgeRefs("body9")).toEqual([]);
    r.b1.edges.object.visible = false;
    expect(r.vp.bodyEdgeRefs("body1")).toEqual([]);
    expect(ids(r.vp.bodyEdgeRefs("body2"))).toEqual(["e4"]);
    Object.assign(r.vp, { model: null });
    expect(r.vp.bodyEdgeRefs("body2")).toEqual([]);
  });
});

describe("picksSuspended", () => {
  it("is false when free, and true for each thing that holds the model", () => {
    expect(rig().vp.picksSuspended).toBe(false);
    for (const held of ["suspendPicking", "streaming", "outOfDate"]) {
      const r = rig();
      Object.assign(r.vp, { [held]: true });
      expect(r.vp.picksSuspended).toBe(true);
    }
  });
});
