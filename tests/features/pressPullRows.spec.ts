// A Geometry list row reaches Press/Pull while it waits for a face and while it waits for the face to stop at.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { PressPullTool } from "../../src/features/pressPullTool";
import {
  endCommandedPick,
  endRewoundPick,
  offerPicks,
  resetTreePicks,
  routeTreeClick,
  treePickWaiting,
} from "../../src/ui/treePick";
import { t } from "../../src/i18n";
import type { DocumentStore, RebuildState } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { PressPullFaces } from "../../src/viewport/faceAnalysis";
import type { Feature, Selector, Vec3 } from "../../src/types";
import type { RoundFace } from "../../src/features/radialDrag";

const PX = 10;
const SLANT = 7;
const OTHER = 9;
const ROUND = 11;
const point = (id: number): Vec3 => [id * 1.5 + 2, -2.25 - id, 7.5 + id / 2];
const face = (id: number): Selector => ({ kind: "face", by: "nearest", point: point(id) });

const bore: RoundFace = {
  cylinder: { axis: [0, 0, 1], point: [3, -5.5, 0], radius: 2.5 },
  radius: 2.5,
  solidInside: false,
  radial: new THREE.Vector3(1, 0, 0),
  full: true,
  tangent: null,
};

function facesOf(ids: readonly number[]): PressPullFaces {
  const round = ids[0] === ROUND ? bore : null;
  return {
    selectors: ids.map(face),
    faceIds: [...ids],
    normal: round ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0.6, 0.8),
    anchor: new THREE.Vector3(...point(ids[0]!)),
    bodyId: "b2",
    round,
    lead: null,
  };
}

function rig(selected: number[] = []) {
  const scene = new THREE.Scene();
  const canvas = document.createElement("canvas");
  const tri = new THREE.Triangle(new THREE.Vector3(0, 0, 0), new THREE.Vector3(5, 0, 0), new THREE.Vector3(0, 5, 3));
  const vp = {
    suspendPicking: false,
    domElement: canvas,
    camera: new THREE.PerspectiveCamera(),
    addToScene: (o: THREE.Object3D) => scene.add(o),
    removeFromScene: (o: THREE.Object3D) => scene.remove(o),
    requestRender: () => {},
    pixelWorldSize: () => 0.1,
    projectToScreen: (p: THREE.Vector3) => ({ x: p.x * PX, y: p.y * PX }),
    snapStep: () => 0.05,
    clearHover: () => {},
    hoverFaceAt: () => null,
    pickFaceForPressPull: () => null,
    selectedFacesForPressPull: () => (selected.length ? facesOf(selected) : null),
    facesForPressPull: (ids: readonly number[]) => facesOf(ids),
    planarFace: (id: number) =>
      id === ROUND ? null : { normal: new THREE.Vector3(0, 0.6, 0.8), origin: new THREE.Vector3(...point(id)) },
    roundFaceAt: (id: number) => (id === ROUND ? bore : null),
    faceTriangles: () => [tri],
    edgesOfFaces: () => [],
    faceIdNear: () => null,
    faceIdToBodyId: () => "b2",
    setPeek: () => {},
    clearPressPullGhost: () => {},
    setPressPullGhost: () => {},
    selectOnlyFace: () => {},
  };
  const added: Feature[] = [];
  const store = {
    nextId: () => "p1",
    setPreview: vi.fn(),
    addFeature: (f: Feature) => added.push(f),
    verifyCommit: () => {},
    onBuild: (_fn: (s: RebuildState) => void) => () => {},
    onSessionBuild: (_fn: (s: RebuildState) => void) => () => {},
    faceAxis: async () => ({ reason: "no axis" }),
  };
  return { vp: vp as unknown as Viewport, store: store as unknown as DocumentStore, added };
}

interface Internals {
  phase: string;
  faces: Selector[];
  faceIds: number[];
  bodyId: string | null;
  resizing: boolean;
  pickingTarget: boolean;
  anchor: THREE.Vector3;
  axis: THREE.Vector3;
  value: number;
  refreshPreview(now?: boolean): void;
}

const seen = (t: PressPullTool) => {
  const i = t as unknown as Internals;
  return {
    phase: i.phase,
    faces: i.faces,
    faceIds: i.faceIds,
    bodyId: i.bodyId,
    resizing: i.resizing,
    anchor: i.anchor.toArray(),
    axis: i.axis.toArray(),
  };
};

const targeting = (t: PressPullTool) => (t as unknown as Internals).pickingTarget;

function begin(selected: number[] = []) {
  const r = rig(selected);
  const done = vi.fn();
  const tool = new PressPullTool(r.vp, r.store);
  tool.start(done);
  return { ...r, tool, done };
}

const hints = () => {
  const said: string[] = [];
  return { said, busyHint: () => null, hint: (t: string) => said.push(t) };
};

const keyOnWindow = (key: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

describe("Press/Pull takes a face row", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    resetTreePicks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("while it waits, a slanted face row starts the drag as that face selected before the start", () => {
    const before = begin([SLANT]);
    const want = seen(before.tool);
    before.tool.cancel();
    resetTreePicks();

    const waiting = begin();
    expect(seen(waiting.tool).phase).toBe("pick");
    const d = hints();
    expect(routeTreeClick({ kind: "face", faceId: SLANT }, d)).toBe("taken");
    expect(seen(waiting.tool)).toEqual(want);
    expect(want.phase).toBe("drag");
    expect(want.anchor).toEqual(point(SLANT));
    expect([d.said, treePickWaiting()]).toEqual([[], false]);
    waiting.tool.cancel();
  });

  it("a round face row starts a resize", () => {
    const { tool } = begin();
    expect(routeTreeClick({ kind: "face", faceId: ROUND }, hints())).toBe("taken");
    expect(seen(tool)).toMatchObject({ phase: "drag", faceIds: [ROUND], resizing: true, axis: [1, 0, 0] });
    tool.cancel();
  });

  it("an edge row is refused in words and the tool keeps waiting", () => {
    const { tool } = begin();
    const d = hints();
    const edge = {
      kind: "edge",
      edge: {
        body: "b2",
        points: [
          [1, 2, 3],
          [4, 5, 6],
        ],
      },
    } as never;
    expect(routeTreeClick(edge, d)).toBe("refused");
    expect([d.said.length, d.said[0], seen(tool).phase, treePickWaiting()]).toEqual([
      1,
      "That row is an edge, this step needs a face",
      "pick",
      true,
    ]);
    tool.cancel();
  });

  it("two face rows offered at once both join one push, and the next click carries on from it", () => {
    const { tool } = begin();
    const after = vi.fn();
    tool.carry = { route: vi.fn(), after };
    const said: string[] = [];
    const d = { ...hints(), say: (text: string) => void said.push(text) };
    offerPicks(
      [
        { pick: { kind: "face", faceId: SLANT }, name: "Flat face 7" },
        { pick: { kind: "face", faceId: OTHER }, name: "Flat face 9" },
      ],
      d,
    );
    expect(seen(tool)).toMatchObject({ phase: "drag", faces: [face(SLANT), face(OTHER)], faceIds: [SLANT, OTHER] });
    expect([after.mock.calls, d.said, said, treePickWaiting()]).toEqual([
      [],
      [],
      [t("pick.doneRun", { n: 2, done: "other" })],
      true,
    ]);
    tool.cancel();
  });

  it("T takes another face row as the face to stop at, as a click on it would", () => {
    const { tool, added, done } = begin();
    routeTreeClick({ kind: "face", faceId: SLANT }, hints());
    expect(treePickWaiting()).toBe(false);
    keyOnWindow("t");
    expect([targeting(tool), treePickWaiting()]).toEqual([true, true]);
    const d = hints();
    expect(routeTreeClick({ kind: "face", faceId: OTHER }, d)).toBe("taken");
    const rounded = point(OTHER).map((c) => Math.round(c * 1e3) / 1e3);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      type: "press-pull",
      upTo: { kind: "face", by: "tracked", point: rounded, normal: [0, 0.6, 0.8] },
    });
    expect([d.said, treePickWaiting(), done.mock.calls.length]).toEqual([[], false, 1]);
  });

  it("T refuses a row of the pushed face and waits for another", () => {
    const { tool, added } = begin();
    routeTreeClick({ kind: "face", faceId: SLANT }, hints());
    keyOnWindow("t");
    const d = hints();
    expect(routeTreeClick({ kind: "face", faceId: SLANT }, d)).toBe("refused");
    expect(d.said).toHaveLength(1);
    expect([added, targeting(tool), treePickWaiting()]).toEqual([[], true, true]);
    expect(routeTreeClick({ kind: "face", faceId: OTHER }, d)).toBe("taken");
    expect(added).toHaveLength(1);
  });

  it("T drops a preview that built, so the view and the rows show the model the stop face is picked on", () => {
    const { tool, store } = begin();
    const sent = vi.mocked(store.setPreview);
    routeTreeClick({ kind: "face", faceId: SLANT }, hints());
    const i = tool as unknown as Internals;
    i.value = 12.5;
    i.refreshPreview(true);
    keyOnWindow("t");
    keyOnWindow("Escape");
    const kinds = sent.mock.calls.map(([f, o]) => [f && !Array.isArray(f) ? [f.type, f.id] : f, o]);
    expect(kinds).toEqual([
      [["press-pull", "p1"], { hold: true }],
      [null, undefined],
      [["press-pull", "p1"], { hold: true }],
    ]);
    tool.cancel();
  });

  it("T with nothing previewed yet sends no drop", () => {
    const { tool, store } = begin();
    routeTreeClick({ kind: "face", faceId: SLANT }, hints());
    keyOnWindow("t");
    expect([vi.mocked(store.setPreview).mock.calls, targeting(tool)]).toEqual([[], true]);
    tool.cancel();
  });

  it("Esc in T ends that session and leaves the tool dragging", () => {
    const { tool, done } = begin();
    routeTreeClick({ kind: "face", faceId: SLANT }, hints());
    keyOnWindow("t");
    keyOnWindow("Escape");
    expect([targeting(tool), treePickWaiting(), done.mock.calls]).toEqual([false, false, []]);
    expect(seen(tool).phase).toBe("drag");
    tool.cancel();
  });

  it("undo, a menu command and a sketch tool key leave the waiting tool and its session", () => {
    const { tool, done } = begin();
    endRewoundPick();
    endCommandedPick();
    expect([treePickWaiting(), done.mock.calls, seen(tool).phase]).toEqual([true, [], "pick"]);
    expect(routeTreeClick({ kind: "face", faceId: OTHER }, hints())).toBe("taken");
    expect(seen(tool).faceIds).toEqual([OTHER]);
    tool.cancel();
  });

  it("a cancel from outside leaves no session, and the next tool's rows are its own", () => {
    const first = begin();
    first.tool.cancel();
    expect([treePickWaiting(), first.done.mock.calls]).toEqual([false, [[null]]]);

    const second = begin();
    expect(routeTreeClick({ kind: "face", faceId: OTHER }, hints())).toBe("taken");
    expect([seen(first.tool).phase, seen(second.tool).faceIds]).toEqual(["pick", [OTHER]]);
    second.tool.cancel();
  });

  it("another pick starting cancels the waiting tool through its end", () => {
    const { tool, done } = begin();
    const other = begin();
    expect(done.mock.calls).toEqual([[null]]);
    expect(treePickWaiting()).toBe(true);
    other.tool.cancel();
    tool.cancel();
  });
});
