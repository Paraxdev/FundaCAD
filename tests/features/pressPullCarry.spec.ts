// Press/Pull carries on: a clean click on another face or an edge finishes the push and hands the pick on, T is the way
// to stop at a face. Empty space, its own face and a refused or unanswered preview keep the old behaviour.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { PressPullTool } from "../../src/features/pressPullTool";
import { carryWords, type CarryHost } from "../../src/features/carryOn";
import { resetTreePicks, routeTreeClick, treePickWaiting } from "../../src/ui/treePick";
import type { DocumentStore, RebuildState } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { PressPullFaces } from "../../src/viewport/faceAnalysis";
import type { Feature, Selector, Vec3 } from "../../src/types";

const prompts = vi.hoisted(() => [] as (string | null)[]);
vi.mock("../../src/ui/prompt", async (actual) => ({
  ...(await actual<typeof import("../../src/ui/prompt")>()),
  setPrompt: (text: string | null) => prompts.push(text),
}));

const PUSHED = 7;
const NEXT = 9;
const point = (id: number): Vec3 => [id * 1.5 + 2, -2.25 - id, 7.5 + id / 2];
const face = (id: number): Selector => ({ kind: "face", by: "nearest", point: point(id) });
const normal = () => new THREE.Vector3(0, 0.6, 0.8);

const SMALL = new THREE.Triangle(
  new THREE.Vector3(15, 2, 3),
  new THREE.Vector3(16, 2, 3),
  new THREE.Vector3(15, 3, 3.5),
);
const LARGE = new THREE.Triangle(
  new THREE.Vector3(15, 2, 3),
  new THREE.Vector3(19, 4, 3),
  new THREE.Vector3(15, 8, 3.5),
);
const LARGE_CENTRE = [(15 + 19 + 15) / 3, (2 + 4 + 8) / 3, (3 + 3 + 3.5) / 3];
const EDGE_POINTS = [
  [12, 1, 5],
  [14, 1, 5],
  [14, 1, 9],
];
const faceHit = (id: number) => ({ kind: "face", faceId: id });
const edgeHit = { kind: "edge", edge: { id: "e7", body: "body1", points: EDGE_POINTS } };

function pushedFaces(): PressPullFaces {
  return {
    selectors: [face(PUSHED)],
    faceIds: [PUSHED],
    normal: normal(),
    anchor: new THREE.Vector3(...point(PUSHED)),
    bodyId: "b2",
    round: null,
    lead: null,
  };
}

const tools: PressPullTool[] = [];
let frames: (() => void)[] = [];
const frame = () => {
  const run = frames;
  frames = [];
  for (const f of run) f();
};

function rig() {
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const under = { hit: null as unknown, stop: null as unknown };
  const lit: unknown[] = [];
  const vp = {
    suspendPicking: false,
    domElement: canvas,
    camera: new THREE.PerspectiveCamera(),
    addToScene: () => {},
    removeFromScene: () => {},
    requestRender: () => {},
    pixelWorldSize: () => 0.1,
    projectToScreen: (p: THREE.Vector3) => ({ x: p.x * 10, y: p.y * 10 }),
    snapStep: () => 0.05,
    clearHover: () => {},
    hoverFaceAt: () => null,
    pickEntity: () => under.hit,
    hoverEntity: (hit: unknown) => void lit.push(hit),
    pickFaceForPressPull: () => under.stop,
    selectedFacesForPressPull: () => pushedFaces(),
    facesForPressPull: () => pushedFaces(),
    planarFace: (id: number) => ({ normal: normal(), origin: new THREE.Vector3(...point(id)) }),
    roundFaceAt: () => null,
    faceTriangles: (id: number) => (id === NEXT ? [SMALL, LARGE] : []),
    edgesOfFaces: () => [],
    faceIdNear: () => null,
    faceIdToBodyId: () => "b2",
    setPeek: () => {},
    clearPressPullGhost: () => {},
    setPressPullGhost: () => {},
    selectOnlyFace: () => {},
    selectOnlyFaces: () => {},
    draftLines: () => [],
  };
  const calls = { added: [] as Feature[], previews: [] as (Feature | null)[], verify: [] as unknown[][] };
  const builds: ((s: RebuildState) => void)[] = [];
  const own = {
    nextId: () => "p1",
    setPreview: (f: Feature | null) => void calls.previews.push(f),
    addFeature: (f: Feature) => void calls.added.push(f),
    verifyCommit: (...a: unknown[]) => void calls.verify.push(a),
    onBuild: (fn: (s: RebuildState) => void) => (builds.push(fn), () => {}),
    onSessionBuild: () => () => {},
    faceAxis: async () => ({ reason: "no axis" }),
    boundExpr: () => null,
    classifyTargetExpr: () => ({ ok: false, error: "Unknown parameter abc" }),
    isParamBound: () => false,
    bareParamRef: () => null,
    document: { features: [], parameters: {} },
  };
  const store = new Proxy(own as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : () => undefined),
  });
  const hints: string[] = [];
  const after = vi.fn();
  const route = vi.fn((pick) => routeTreeClick(pick, { busyHint: () => null, hint: (m) => void hints.push(m) }));
  const host: CarryHost = { route, after };
  const tool = new PressPullTool(vp as unknown as Viewport, store as unknown as DocumentStore);
  tools.push(tool);
  Object.assign(tool, { hitGizmo: () => false, hitTaper: () => false });
  tool.carry = host;
  const pointer = (type: string, x = 300, y = 200, extra: PointerEventInit = {}) =>
    canvas.dispatchEvent(
      new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true, ...extra }),
    );
  const click = (x = 300, y = 200, extra: PointerEventInit = {}) => {
    pointer("pointerdown", x, y, extra);
    pointer("pointerup", x, y, extra);
  };
  const type = (text: string) => {
    const input = document.querySelector<HTMLInputElement>(".dim-input input")!;
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    frame();
    vi.advanceTimersByTime(200);
  };
  const keyInBox = (k: string) =>
    document
      .querySelector<HTMLInputElement>(".dim-input input")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  const key = (k: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  // The engine's answer for the preview last sent: the push builds, or the kernel refuses it.
  const answer = (refusal?: string) => {
    const sent = calls.previews.filter(Boolean).at(-1)!;
    const reply = refusal
      ? { building: false, result: {}, previewBuilt: [sent], heldRefusal: { featureId: "p1", message: refusal } }
      : { building: false, result: {}, previewBuilt: [sent], errorFeatureId: null, errorMessage: null };
    for (const fn of builds) fn(reply as unknown as RebuildState);
  };
  const done = vi.fn();
  const begin = () => tool.start(done);
  return {
    tool,
    calls,
    hints,
    host,
    route,
    after,
    under,
    lit,
    pointer,
    click,
    type,
    key,
    keyInBox,
    answer,
    begin,
    done,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => frames.push(fn));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  prompts.length = 0;
});
afterEach(() => {
  for (const tool of tools.splice(0)) if (tool.active) tool.cancel();
  resetTreePicks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/** A typed distance the engine has answered for. */
function pushed(r: ReturnType<typeof rig>, text: string) {
  r.begin();
  r.type(text);
  r.answer();
}

const PUSH_7 = { id: "p1", type: "press-pull", face: face(PUSHED), distance: 7.25, operation: "join", body: "b2" };

describe("a click after the push is set carries on", () => {
  it("on another face writes the push once and hands the face's inner point on, never stopping at it", () => {
    const r = rig();
    pushed(r, "7.25");
    r.under.hit = faceHit(NEXT);
    r.click();
    expect(r.calls.added).toEqual([PUSH_7]);
    expect(r.after).toHaveBeenCalledTimes(1);
    expect(r.after).toHaveBeenCalledWith({ kind: "added", id: "p1" }, { kind: "face", point: LARGE_CENTRE });
    expect(r.tool.active).toBe(false);
    expect(treePickWaiting()).toBe(false);
    expect(r.done).toHaveBeenCalledWith("p1");
  });

  it("on an edge hands the edge's middle on", () => {
    const r = rig();
    pushed(r, "-3.5");
    r.under.hit = edgeHit;
    r.click();
    expect(r.calls.added).toEqual([{ ...PUSH_7, distance: -3.5, operation: "cut" }]);
    expect(r.after).toHaveBeenCalledWith({ kind: "added", id: "p1" }, { kind: "edge", point: [14, 1, 6] });
  });

  it("on empty space or a body only commits", () => {
    const r = rig();
    pushed(r, "7.25");
    r.under.hit = { kind: "body", bodyId: "b2" };
    r.click();
    expect(r.calls.added).toEqual([PUSH_7]);
    expect(r.route).not.toHaveBeenCalled();
    expect(r.after).not.toHaveBeenCalled();
  });

  it("on one of its own faces only commits", () => {
    const r = rig();
    pushed(r, "7.25");
    r.under.hit = faceHit(PUSHED);
    r.click();
    expect(r.calls.added).toEqual([PUSH_7]);
    expect(r.route).not.toHaveBeenCalled();
    expect(r.after).not.toHaveBeenCalled();
  });

  it("with a press that travelled is a drag, not a click", () => {
    const r = rig();
    pushed(r, "7.25");
    r.under.hit = faceHit(NEXT);
    r.pointer("pointerdown", 300, 200);
    r.pointer("pointerup", 312, 200);
    expect(r.calls.added).toEqual([]);
    expect(r.after).not.toHaveBeenCalled();
    expect(r.tool.active).toBe(true);
  });

  it("at zero adds nothing, closes the step and carries on to the face", () => {
    const r = rig();
    r.begin();
    r.under.hit = faceHit(NEXT);
    r.click();
    expect(r.calls.added).toEqual([]);
    expect(r.after).toHaveBeenCalledWith({ kind: "nothing" }, { kind: "face", point: LARGE_CENTRE });
    expect(r.tool.active).toBe(false);
    expect(r.done).toHaveBeenCalledWith(null);
  });

  it("with a Ctrl click adds the face to the push and carries nothing", () => {
    const r = rig();
    r.begin();
    r.under.stop = {
      selector: face(NEXT),
      faceId: NEXT,
      anchor: new THREE.Vector3(...point(NEXT)),
      normal: normal(),
      bodyId: "b2",
    };
    r.under.hit = faceHit(NEXT);
    r.click(300, 200, { ctrlKey: true });
    expect(r.tool.active).toBe(true);
    expect(r.calls.added).toEqual([]);
    expect(r.route).not.toHaveBeenCalled();
    r.type("7.25");
    r.tool.confirmHeld();
    expect(r.calls.added).toEqual([
      {
        id: "p1",
        type: "press-pull",
        face: [face(PUSHED), face(NEXT)],
        distance: 7.25,
        operation: "join",
        body: "b2",
      },
    ]);
  });

  it("through a Geometry row or a bracket pick reaches the same rule", () => {
    const r = rig();
    pushed(r, "7.25");
    const hints = { busyHint: () => null, hint: () => {} };
    expect(routeTreeClick({ kind: "face", faceId: NEXT }, hints)).toBe("taken");
    expect(r.calls.added).toEqual([PUSH_7]);
    expect(r.after).toHaveBeenCalledWith({ kind: "added", id: "p1" }, { kind: "face", point: LARGE_CENTRE });
  });

  it("through a row that is neither a face nor an edge is refused and the push stays open", () => {
    const r = rig();
    pushed(r, "7.25");
    const said: string[] = [];
    expect(routeTreeClick({ kind: "body", id: "b2" }, { busyHint: () => null, hint: (m) => void said.push(m) })).toBe(
      "refused",
    );
    expect(said).toHaveLength(1);
    expect(r.calls.added).toEqual([]);
    expect(r.tool.active).toBe(true);
  });
});

describe("a click that cannot finish the push", () => {
  it("while the engine has not answered yet is refused, commits nothing and works once it has", () => {
    const r = rig();
    r.begin();
    r.type("7.25");
    r.under.hit = faceHit(NEXT);
    r.click();
    expect(r.calls.added).toEqual([]);
    expect(r.calls.verify).toEqual([]);
    expect(r.hints).toEqual([carryWords.wait()]);
    expect(r.tool.active).toBe(true);
    r.answer();
    r.click();
    expect(r.calls.added).toEqual([PUSH_7]);
    expect(r.after).toHaveBeenCalledTimes(1);
  });

  it("with a refused push gives the kernel's reason, commits nothing and keeps the step open", () => {
    const r = rig();
    r.begin();
    r.type("7.25");
    r.answer("Press/Pull failed: the wall is too thin");
    r.under.hit = edgeHit;
    r.click();
    expect(r.calls.added).toEqual([]);
    expect(r.hints).toEqual([carryWords.refused("the wall is too thin")]);
    expect(r.after).not.toHaveBeenCalled();
    expect(r.tool.active).toBe(true);
    expect(treePickWaiting()).toBe(true);
  });

  it("with a typed value that cannot be read is refused", () => {
    const r = rig();
    pushed(r, "7.25");
    r.type("abc");
    r.under.hit = faceHit(NEXT);
    r.click();
    expect(r.calls.added).toEqual([]);
    expect(r.hints).toEqual([carryWords.badValue()]);
    expect(r.tool.active).toBe(true);
  });
});

describe("T stops at a face", () => {
  it("then a click on a face makes the push up to it and carries nothing", () => {
    const r = rig();
    r.begin();
    r.key("t");
    expect(prompts.at(-1)).toMatch(/stop at/i);
    r.under.stop = {
      selector: face(NEXT),
      faceId: NEXT,
      anchor: new THREE.Vector3(...point(NEXT)),
      normal: normal(),
      bodyId: "b2",
    };
    r.under.hit = faceHit(NEXT);
    r.click();
    const rounded = point(NEXT).map((c) => Math.round(c * 1e3) / 1e3);
    expect(r.calls.added).toEqual([
      {
        id: "p1",
        type: "press-pull",
        face: face(PUSHED),
        distance: 0,
        operation: "join",
        body: "b2",
        upTo: { kind: "face", by: "tracked", point: rounded, normal: [0, 0.6, 0.8], body: "b2" },
      },
    ]);
    expect(r.route).not.toHaveBeenCalled();
    expect(r.after).not.toHaveBeenCalled();
    expect(r.tool.active).toBe(false);
    expect(treePickWaiting()).toBe(false);
  });

  it("holds the carry session back while it waits for the face and hands it back on Esc", () => {
    const r = rig();
    r.begin();
    expect(treePickWaiting()).toBe(true);
    r.key("t");
    r.under.hit = faceHit(NEXT);
    r.pointer("pointermove", 310, 210);
    expect(r.lit).toEqual([]);
    r.key("Escape");
    expect(r.tool.active).toBe(true);
    expect(treePickWaiting()).toBe(true);
    r.pointer("pointermove", 320, 220);
    expect(r.lit).toEqual([faceHit(NEXT)]);
    r.click();
    expect(r.after).toHaveBeenCalledWith({ kind: "nothing" }, { kind: "face", point: LARGE_CENTRE });
  });

  it("is a letter in the value box once a value is typed", () => {
    const r = rig();
    r.begin();
    r.type("7");
    r.keyInBox("t");
    r.under.hit = faceHit(NEXT);
    r.pointer("pointermove", 310, 210);
    expect(r.lit).toEqual([faceHit(NEXT)]);
  });
});

describe("the session of an open Press/Pull", () => {
  it("opens with the drag phase and ends with the tool", () => {
    const r = rig();
    expect(treePickWaiting()).toBe(false);
    r.begin();
    expect(treePickWaiting()).toBe(true);
    r.tool.cancel();
    expect(treePickWaiting()).toBe(false);
  });

  it("is not opened where nothing hands a pick on", () => {
    const r = rig();
    r.tool.carry = null;
    r.begin();
    expect(treePickWaiting()).toBe(false);
  });
});

describe("hover and prompt", () => {
  it("light the face or edge a click would carry to, and clear when the step ends", () => {
    const r = rig();
    r.begin();
    r.under.hit = faceHit(NEXT);
    r.pointer("pointermove", 310, 210);
    r.under.hit = edgeHit;
    r.pointer("pointermove", 320, 220);
    r.under.hit = null;
    r.pointer("pointermove", 330, 230);
    expect(r.lit).toEqual([faceHit(NEXT), edgeHit, null]);
    r.under.hit = faceHit(NEXT);
    r.pointer("pointermove", 340, 240);
    r.tool.cancel();
    expect(r.lit.at(-1)).toBeNull();
  });

  it("say that T stops at a face and a click goes on", () => {
    const r = rig();
    r.begin();
    expect(prompts.at(-1)).toContain(carryWords.prompt());
    expect(prompts.at(-1)).toMatch(/T stops at a face/);
  });
});
