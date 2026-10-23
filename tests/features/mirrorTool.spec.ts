// The 3D Mirror tool against a stand-in viewport: what the clicks, rows and keys put in each field, and that a run
// writes one feature or nothing and always gives the canvas back.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { MirrorTool, PLANE_REFUSED } from "../../src/features/mirrorTool";
import { basePlaneDef, reflectionMatrix } from "../../src/features/mirrorMath";
import { useToolPanelStore } from "../../src/stores/toolPanels";
import { usePromptStore } from "../../src/stores/prompt";
import { endPickSession, resetTreePicks, routeTreeClick, treePickWaiting, type TreePick } from "../../src/ui/treePick";
import type { FacePlanePick, PlanePickTarget } from "../../src/features/facePlanePick";
import type { PlaneDef } from "../../src/types";
import type { Viewport } from "../../src/viewport/viewport";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import type { Feature, RebuildReply } from "../../src/types";

const DATUM: PlaneDef = { origin: [4, -2.5, 9], normal: [0.6, 0, 0.8], xdir: [0, 1, 0] };

const FLAT: FacePlanePick = {
  def: { origin: [12, 3.5, -4], normal: [0.28, -0.96, 0], xdir: [0.96, 0.28, 0] },
  kind: "planar",
  selector: { kind: "face", by: "nearest", point: [12, 3.5, -4], body: "body2" },
  faceId: 31,
  at: [12, 3.5, -4],
};
const ROUND: FacePlanePick = {
  def: { origin: [-6, 2, 7.5], normal: [0, 0.6, 0.8], xdir: [1, 0, 0] },
  kind: "tangent",
  selector: { kind: "face", by: "nearest", point: [-6, 2, 7.5], body: "body1" },
  faceId: 12,
  at: [-6, 2, 7.5],
};

// Screen x decides what is under the cursor: bodies left of 100, planes and faces right of it.
const BODY_AT: Record<number, string> = { 20: "body1", 40: "body2", 60: "body3" };
const PLANE_AT: Record<number, PlanePickTarget> = {
  120: { kind: "base", spec: "XZ" },
  140: { kind: "datum", spec: DATUM, id: "f5" },
  160: { kind: "unusable" },
  170: { kind: "face", spec: FLAT.def, face: FLAT },
  180: { kind: "face", spec: ROUND.def, face: ROUND },
};

function rig(bodyIds = ["body1", "body2", "body3"]) {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const log = {
    selected: [] as string[],
    planesShown: false,
    ghost: null as null | { bodies: readonly string[]; matrices: readonly THREE.Matrix4[] },
    hoverBody: null as string | null,
    hoverFace: 0,
    litPlane: null as string | null,
    litDatum: null as string | null,
    faceMarks: null as null | { faceIds: number[]; color: number }[],
  };
  const viewport = {
    domElement: canvas,
    suspendPicking: false,
    bodyIdAt: (x: number) => BODY_AT[x] ?? null,
    setSelectedBodies: (ids: string[]) => {
      log.selected = [...ids];
    },
    showAllPlanes: (on: boolean) => {
      log.planesShown = on;
    },
    setPatternGhost: (bodies: readonly string[], matrices: readonly THREE.Matrix4[]) => {
      log.ghost = { bodies: [...bodies], matrices };
    },
    clearPatternGhost: () => {
      log.ghost = null;
    },
    hoverBody: (id: string | null) => {
      log.hoverBody = id;
    },
    hoverPlane: (p: string | null) => {
      log.litPlane = p;
    },
    highlightDatum: (id: string | null) => {
      log.litDatum = id;
    },
    setFaceMarks: (marks: { faceIds: number[]; color: number }[] | null, layer: string) => {
      if (layer === "mirror") log.faceMarks = marks;
    },
    hoverDatum: () => {},
    hoverFaceAt: () => {
      log.hoverFace++;
    },
    clearHover: () => {},
  } as unknown as Viewport;
  const addFeatures = vi.fn();
  const store = {
    document: { features: [{ id: "f5", type: "datumPlane", plane: DATUM, name: "Slant" }] },
    buildState: { result: { bodies: bodyIds.map((id) => ({ id, name: id })) } },
    addFeatures,
  } as unknown as DocumentStore;
  const tool = new MirrorTool(viewport, store, (_vp, x) => PLANE_AT[x] ?? null);
  const done = vi.fn();
  return { tool, viewport, log, addFeatures, done, canvas };
}

const panel = () => useToolPanelStore().mirror;
const prompt = () => usePromptStore().text;
const summary = () => {
  const v = panel();
  return v && { active: v.active, values: v.fields.map((f) => f.value), plane: v.plane, ready: v.ready };
};

function click(el: HTMLElement, x: number, mods: { shiftKey?: boolean; ctrlKey?: boolean } = {}) {
  const e = new MouseEvent("pointerdown", { button: 0, clientX: x, clientY: 50, cancelable: true, ...mods });
  el.dispatchEvent(e);
  return e.defaultPrevented;
}
function key(k: string, target: EventTarget = window) {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}
const row = (pick: TreePick) => {
  const hints: string[] = [];
  const route = routeTreeClick(pick, { busyHint: () => null, hint: (h) => hints.push(h) });
  return { route, hints };
};

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  resetTreePicks();
  document.body.innerHTML = "";
});

describe("starting", () => {
  it("starts on Objects with nothing picked", () => {
    const r = rig();
    r.tool.start([], r.done);
    expect(summary()).toEqual({
      active: "objects",
      values: ["Nothing picked", "Nothing picked"],
      plane: null,
      ready: false,
    });
    expect(panel()!.planes).toEqual(["XY", "XZ", "YZ"]);
    expect(r.viewport.suspendPicking).toBe(true);
    expect(r.log.planesShown).toBe(false);
    expect(r.tool.active).toBe(true);
  });

  it("puts one preselected body in Objects and asks for the plane", () => {
    const r = rig();
    r.tool.start(["body2"], r.done);
    expect(summary()).toEqual({ active: "line", values: ["1 body", "Nothing picked"], plane: null, ready: false });
    expect(r.log.selected).toEqual(["body2"]);
    expect(r.log.planesShown).toBe(true);
  });

  it("puts several preselected bodies in Objects", () => {
    const r = rig();
    r.tool.start(["body3", "body1"], r.done);
    expect(summary()!.values[0]).toBe("2 bodies");
    expect(r.log.selected).toEqual(["body3", "body1"]);
  });

  it("does not start twice", () => {
    const r = rig();
    r.tool.start(["body1"], r.done);
    const id = panel()!.id;
    r.tool.start([], r.done);
    expect(panel()!.id).toBe(id);
    expect(summary()!.values[0]).toBe("1 body");
  });
});

describe("picking", () => {
  it("plain body clicks add one and many while Objects is active, Enter moves on to the plane", () => {
    const r = rig();
    r.tool.start([], r.done);
    expect(click(r.canvas, 40)).toBe(true);
    expect(summary()).toEqual({ active: "objects", values: ["1 body", "Nothing picked"], plane: null, ready: false });
    expect(prompt()).toContain("Pick what to mirror, Enter when done");
    click(r.canvas, 60);
    click(r.canvas, 20);
    expect(r.log.selected).toEqual(["body2", "body3", "body1"]);
    expect(summary()!.active).toBe("objects");
    key("Enter");
    expect(summary()!.active).toBe("line");
    expect(prompt()).toContain("Pick the mirror plane");
    expect(r.addFeatures).not.toHaveBeenCalled();
  });

  it("Enter with no body picked stays on Objects", () => {
    const r = rig();
    r.tool.start([], r.done);
    key("Enter");
    expect(summary()!.active).toBe("objects");
    expect(prompt()).toContain("Pick what to mirror");
  });

  it("a set plane hands the clicks back to Objects, so a body click adds it, not its face", () => {
    const r = rig();
    r.tool.start(["body1"], r.done);
    click(r.canvas, 120);
    expect(summary()!.active).toBe("objects");
    expect(prompt()).toContain("Enter to mirror");
    click(r.canvas, 40);
    expect(summary()).toEqual({ active: "objects", values: ["2 bodies", "XZ plane"], plane: "XZ", ready: true });
  });

  it("keeps the picked plane lit, a face in the line colour, and puts it out at the end", () => {
    const r = rig();
    r.tool.start(["body1"], r.done);
    expect([r.log.litPlane, r.log.litDatum, r.log.faceMarks]).toEqual([null, null, null]);
    click(r.canvas, 120);
    expect([r.log.litPlane, r.log.planesShown]).toEqual(["XZ", true]);
    r.canvas.dispatchEvent(new MouseEvent("pointermove", { clientX: 40, clientY: 50 }));
    expect(r.log.litPlane).toBe("XZ");
    r.tool.activate("line");
    click(r.canvas, 140);
    expect([r.log.litPlane, r.log.litDatum, r.log.faceMarks]).toEqual([null, "f5", null]);
    r.tool.activate("line");
    click(r.canvas, 170);
    expect([r.log.litPlane, r.log.litDatum]).toEqual([null, null]);
    expect(r.log.faceMarks).toEqual([{ faceIds: [FLAT.faceId], color: 0xb48cff }]);
    key("Escape");
    expect([r.log.litPlane, r.log.litDatum, r.log.faceMarks, r.log.planesShown]).toEqual([null, null, null, false]);
  });

  it("Shift and Ctrl clicks add bodies whichever field is active", () => {
    const r = rig();
    r.tool.start([], r.done);
    click(r.canvas, 20, { shiftKey: true });
    expect(summary()!.active).toBe("objects");
    click(r.canvas, 60, { ctrlKey: true });
    r.tool.activate("line");
    click(r.canvas, 40, { shiftKey: true });
    expect(r.log.selected).toEqual(["body1", "body3", "body2"]);
    expect(summary()!.active).toBe("line");
    // and toggles one off again
    click(r.canvas, 60, { shiftKey: true });
    expect(r.log.selected).toEqual(["body1", "body2"]);
  });

  it("a miss changes nothing and lets the press through", () => {
    const r = rig();
    r.tool.start([], r.done);
    expect(click(r.canvas, 90)).toBe(false);
    r.tool.activate("line");
    expect(click(r.canvas, 90)).toBe(false);
    expect(summary()).toEqual({
      active: "line",
      values: ["Nothing picked", "Nothing picked"],
      plane: null,
      ready: false,
    });
  });

  it("an origin plane click sets the plane and shows the reflected ghost", () => {
    const r = rig();
    r.tool.start(["body1", "body3"], r.done);
    expect(click(r.canvas, 120)).toBe(true);
    expect(summary()).toEqual({ active: "objects", values: ["2 bodies", "XZ plane"], plane: "XZ", ready: true });
    expect(r.log.ghost!.bodies).toEqual(["body1", "body3"]);
    expect(r.log.ghost!.matrices.map((m) => m.elements)).toEqual([
      new THREE.Matrix4().elements,
      reflectionMatrix(basePlaneDef("XZ")).elements,
    ]);
  });

  it("a datum plane click sets it by name", () => {
    const r = rig();
    r.tool.start(["body2"], r.done);
    click(r.canvas, 140);
    expect(summary()).toEqual({ active: "objects", values: ["1 body", "Slant"], plane: null, ready: true });
    expect(r.log.ghost!.matrices[1]!.elements).toEqual(reflectionMatrix(DATUM).elements);
  });

  it("a face with no plane is refused and the prompt says so", () => {
    const r = rig();
    r.tool.start(["body2"], r.done);
    expect(click(r.canvas, 160)).toBe(true);
    expect(summary()!.values[1]).toBe("Nothing picked");
    expect(prompt()!.startsWith(PLANE_REFUSED)).toBe(true);
    expect(prompt()).toContain("Pick the mirror plane");
    click(r.canvas, 120);
    expect(prompt()!.includes(PLANE_REFUSED)).toBe(false);
  });

  it("a round face is refused and a flat one beside it is taken", () => {
    const r = rig();
    r.tool.start(["body1"], r.done);
    expect(click(r.canvas, 180)).toBe(true);
    expect(summary()!.values[1]).toBe("Nothing picked");
    expect(prompt()!.startsWith(PLANE_REFUSED)).toBe(true);
    expect(r.log.ghost).toBeNull();
    click(r.canvas, 170);
    expect(summary()).toEqual({ active: "objects", values: ["1 body", "Flat face"], plane: null, ready: true });
    expect(r.log.ghost!.matrices[1]!.elements).toEqual(reflectionMatrix(FLAT.def).elements);
  });

  it("hover lights a flat face and not a round one", () => {
    const r = rig();
    r.tool.start(["body1"], r.done);
    r.canvas.dispatchEvent(new MouseEvent("pointermove", { clientX: 180, clientY: 50 }));
    expect(r.log.hoverFace).toBe(0);
    r.canvas.dispatchEvent(new MouseEvent("pointermove", { clientX: 170, clientY: 50 }));
    expect(r.log.hoverFace).toBe(1);
  });

  it("the chips set an origin plane and replace the last one", () => {
    const r = rig();
    r.tool.start(["body1"], r.done);
    click(r.canvas, 140);
    panel()!.onPlane("YZ");
    expect(summary()).toEqual({ active: "objects", values: ["1 body", "YZ plane"], plane: "YZ", ready: true });
  });

  it("clearing a field empties it, makes it active and drops the ghost", () => {
    const r = rig();
    r.tool.start(["body1"], r.done);
    panel()!.onPlane("XY");
    panel()!.onClear("objects");
    expect(summary()).toEqual({ active: "objects", values: ["Nothing picked", "XY plane"], plane: "XY", ready: false });
    expect(r.log.ghost).toBeNull();
    expect(r.log.selected).toEqual([]);
    panel()!.onClear("line");
    expect(summary()!.values[1]).toBe("Nothing picked");
  });

  it("removes a body or the plane from its list", () => {
    const r = rig();
    r.tool.start(["body1"], r.done);
    panel()!.onPlane("XY");
    expect(panel()!.fields.map((f) => f.items)).toEqual([["body1"], ["XY plane"]]);
    panel()!.onRemove("line", 0);
    expect(summary()!.values[1]).toBe("Nothing picked");
    expect(r.log.ghost).toBeNull();
    panel()!.onRemove("objects", 0);
    expect(summary()!.values[0]).toBe("Nothing picked");
    expect(r.log.selected).toEqual([]);
  });

  it("hover lights a body only while Objects takes the click", () => {
    const r = rig();
    r.tool.start([], r.done);
    r.canvas.dispatchEvent(new MouseEvent("pointermove", { clientX: 40, clientY: 50 }));
    expect(r.log.hoverBody).toBe("body2");
    r.tool.activate("line");
    r.canvas.dispatchEvent(new MouseEvent("pointermove", { clientX: 40, clientY: 50 }));
    expect(r.log.hoverBody).toBeNull();
  });
});

describe("Items rows", () => {
  it("a body row picks it, a folder adds its built bodies", () => {
    const r = rig();
    r.tool.start([], r.done);
    expect(row({ kind: "body", id: "body3" }).route).toBe("taken");
    expect(summary()!.active).toBe("objects");
    expect(row({ kind: "bodies", ids: ["body3", "body1", "body8"] }).route).toBe("taken");
    expect(r.log.selected).toEqual(["body3", "body1"]);
    expect(summary()!.active).toBe("objects");
  });

  it("a folder of bodies already picked is refused", () => {
    const r = rig();
    r.tool.start(["body1", "body2"], r.done);
    const out = row({ kind: "bodies", ids: ["body2", "body1"] });
    expect(out.route).toBe("refused");
    expect(out.hints).toHaveLength(1);
  });

  it("plane rows set the plane, a sketch row is refused", () => {
    const r = rig();
    r.tool.start(["body1"], r.done);
    expect(row({ kind: "datumPlane", id: "f5", def: DATUM }).route).toBe("taken");
    expect(summary()!.values[1]).toBe("Slant");
    expect(row({ kind: "basePlane", plane: "XY" }).route).toBe("taken");
    expect(summary()!.plane).toBe("XY");
    const sketch = row({ kind: "sketch", id: "f2" });
    expect(sketch.route).toBe("refused");
    expect(sketch.hints).toHaveLength(1);
    expect(summary()!.plane).toBe("XY");
  });
});

describe("keys and the end of a run", () => {
  it("Enter writes one mirror feature and gives everything back", () => {
    const r = rig();
    r.tool.start(["body3", "body1"], r.done);
    click(r.canvas, 140);
    expect(key("Enter")).toBe(true);
    expect(r.addFeatures.mock.calls).toEqual([
      [[{ id: "f2", type: "mirror", plane: { name: "f5" }, bodies: ["body3", "body1"] }]],
    ]);
    expect(r.done.mock.calls).toEqual([["f2"]]);
    expect(r.tool.active).toBe(false);
    expect(panel()).toBeNull();
    expect(prompt()).toBeNull();
    expect(r.log).toMatchObject({ selected: [], planesShown: false, ghost: null });
    expect(r.viewport.suspendPicking).toBe(false);
    expect(treePickWaiting()).toBe(false);
    // the gesture is detached
    click(r.canvas, 40);
    expect(r.log.selected).toEqual([]);
  });

  it("a flat face commits a datum plane and the mirror across it in one step", () => {
    const r = rig();
    r.tool.start(["body2", "body3"], r.done);
    click(r.canvas, 170);
    key("Enter");
    expect(r.addFeatures.mock.calls).toEqual([
      [
        [
          { id: "f2", type: "datumPlane", plane: FLAT.def, offset: 0, face: FLAT.selector, name: "Mirror plane" },
          { id: "f3", type: "mirror", plane: { name: "f2" }, bodies: ["body2", "body3"] },
        ],
      ],
    ]);
    expect(r.done.mock.calls).toEqual([["f3"]]);
  });

  it("Enter without a plane writes nothing and keeps the tool", () => {
    const r = rig();
    r.tool.start(["body1"], r.done);
    key("Enter");
    expect(r.tool.commit()).toBe(false);
    expect(r.addFeatures).not.toHaveBeenCalled();
    expect(r.tool.active).toBe(true);
  });

  it("Enter without bodies writes nothing", () => {
    const r = rig();
    r.tool.start([], r.done);
    panel()!.onPlane("XY");
    key("Enter");
    expect(r.addFeatures).not.toHaveBeenCalled();
    expect(summary()!.ready).toBe(false);
  });

  it("the panel's button commits like Enter", () => {
    const r = rig();
    r.tool.start(["body2"], r.done);
    panel()!.onPlane("YZ");
    panel()!.onCommit();
    expect(r.addFeatures.mock.calls).toEqual([
      [[{ id: "f2", type: "mirror", plane: { name: "YZ" }, bodies: ["body2"] }]],
    ]);
  });

  it("Enter and Tab on a focused panel button are the button's", () => {
    const r = rig();
    r.tool.start(["body2"], r.done);
    panel()!.onPlane("YZ");
    const host = document.createElement("div");
    host.className = "mirror-panel";
    const btn = document.createElement("button");
    host.appendChild(btn);
    document.body.appendChild(host);
    expect(key("Enter", btn)).toBe(false);
    expect(key("Tab", btn)).toBe(false);
    expect(r.addFeatures).not.toHaveBeenCalled();
    expect(summary()!.active).toBe("objects");
  });

  it("Tab switches the field", () => {
    const r = rig();
    r.tool.start(["body2"], r.done);
    expect(key("Tab")).toBe(true);
    expect(summary()!.active).toBe("objects");
    expect(r.log.planesShown).toBe(false);
    key("Tab");
    expect(summary()!.active).toBe("line");
  });

  it("Escape cancels, writes nothing and puts the old selection back", () => {
    const r = rig();
    r.tool.start(["body2"], r.done);
    click(r.canvas, 20, { shiftKey: true });
    panel()!.onPlane("XZ");
    key("Escape");
    expect(r.addFeatures).not.toHaveBeenCalled();
    expect(r.done.mock.calls).toEqual([[null]]);
    expect(r.log).toMatchObject({ selected: ["body2"], planesShown: false, ghost: null });
    expect(r.viewport.suspendPicking).toBe(false);
    expect(treePickWaiting()).toBe(false);
    expect(panel()).toBeNull();
    expect(prompt()).toBeNull();
  });

  it("ending the Items pick session stands it down", () => {
    const r = rig();
    r.tool.start(["body2"], r.done);
    endPickSession();
    expect(r.tool.active).toBe(false);
    expect(r.done.mock.calls).toEqual([[null]]);
    expect(panel()).toBeNull();
  });

  it("a second run starts empty, with a fresh panel", () => {
    const r = rig();
    r.tool.start(["body1"], r.done);
    panel()!.onPlane("XY");
    const first = panel()!;
    r.tool.cancel();
    r.tool.start([], r.done);
    expect(panel()!.id).not.toBe(first.id);
    expect(summary()).toEqual({
      active: "objects",
      values: ["Nothing picked", "Nothing picked"],
      plane: null,
      ready: false,
    });
    expect(r.log.ghost).toBeNull();
  });
});

describe("store undo and redo", () => {
  const backend = {
    async rebuild(): Promise<RebuildReply> {
      return { ok: false, error: { message: "stub" } };
    },
    async init() {},
    onStatus: () => () => {},
    connected: true,
  } as unknown as GeometryBackend;

  // The engine ends the Items pick session on every rewind, as src/app/engine.ts wires it.
  function real() {
    const store = new DocumentStore(backend, {
      parameters: {},
      features: [
        { id: "s1", type: "sketch", plane: "XY", entities: [] },
        { id: "f2", type: "datumPlane", plane: DATUM, offset: 3.5 },
      ] as Feature[],
    });
    store.onRewind(endPickSession);
    const r = rig();
    const tool = new MirrorTool(r.viewport, store, (_vp, x) => PLANE_AT[x] ?? null);
    return { store, tool, r };
  }

  it("an undo mid run stands the tool down before the picks go stale", () => {
    const { store, tool, r } = real();
    store.addFeature({ id: "f3", type: "datumPlane", plane: DATUM, offset: -6.25 } as Feature);
    tool.start(["body2"], r.done);
    click(r.canvas, 140);
    expect(summary()!.ready).toBe(true);
    store.undo();
    expect(tool.active).toBe(false);
    expect(panel()).toBeNull();
    expect(r.done.mock.calls).toEqual([[null]]);
    expect(tool.commit()).toBe(false);
    expect(store.document.features.map((f) => f.id)).toEqual(["s1", "f2"]);
  });

  it("a redo mid run stands it down too, and with nothing to undo the run goes on", () => {
    const { store, tool, r } = real();
    store.addFeature({ id: "f3", type: "datumPlane", plane: DATUM, offset: -6.25 } as Feature);
    store.undo();
    tool.start(["body1"], r.done);
    store.redo();
    expect(tool.active).toBe(false);
    tool.start(["body1"], r.done);
    store.redo();
    expect(tool.active).toBe(true);
    tool.cancel();
  });
});
