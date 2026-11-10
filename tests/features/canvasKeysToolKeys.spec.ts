// The 3D view's keys over a real waiting tool: ] steps the Geometry rows, Enter gives the lit one to the tool as a click
// on it would, and the Enter after that is the tool's own again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createPinia, setActivePinia } from "pinia";
import { installCanvasPick, type CanvasPickHost } from "../../src/app/canvasPick";
import { EdgeFeatureTool } from "../../src/features/edgeFeatureTool";
import { MirrorTool } from "../../src/features/mirrorTool";
import { TextOnFaceTool } from "../../src/features/textOnFaceTool";
import { useToolPanelStore } from "../../src/stores/toolPanels";
import { announce } from "../../src/ui/announce";
import { t } from "../../src/i18n";
import { resetTreePicks, treePickWaiting } from "../../src/ui/treePick";
import type { FaceAnchorReply } from "../../src/geometry/client";
import type { Viewport } from "../../src/viewport/viewport";
import { edge, land, result, rig, topology } from "../app/geometryBrowserRig";
import { asVec, faceRowViewport, FLAT_ANCHOR, SLANT_NORMAL } from "./faceRowRig";

vi.mock("../../src/ui/toast", () => ({
  toast: () => {},
  dismissToast: () => {},
  dismissToastsSaying: () => {},
  hintToast: () => {},
}));
vi.mock("../../src/ui/announce", async (actual) => ({
  ...(await actual<typeof import("../../src/ui/announce")>()),
  announce: vi.fn(),
}));

const said = () => vi.mocked(announce).mock.calls.map((c) => c[0]);

let canvas: HTMLCanvasElement;
const stops: (() => void)[] = [];

function key(k: string) {
  const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  canvas.dispatchEvent(ev);
  return ev;
}

// A held key's repeats go to whatever has focus by then, which the take may have moved to the tool's value box.
function repeatOnFocus(k: string) {
  const ev = new KeyboardEvent("keydown", { key: k, repeat: true, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(ev);
  return ev;
}

// Faces 14 (flat, slanted), 15 (half cylinder) and 16 (sphere patch) are the ones faceRowRig can answer for.
async function mirrorWaiting() {
  const r = rig(result([{ id: "body1", etag: "e1", faceStart: 14 }]));
  let tool: MirrorTool | null = null;
  const host = {
    ...r.host,
    geometryBrowser: r.browser,
    viewport: { domElement: canvas },
    toolOwnsScreen: () => tool?.active ?? false,
  };
  stops.push(installCanvasPick(host as unknown as CanvasPickHost));
  await r.build();
  r.browser.show(true);
  await land(r.asks[0]!, topology("body1", 3));
  r.browser.show(false);

  const viewport = {
    domElement: canvas,
    suspendPicking: false,
    bodyIdAt: () => null,
    setSelectedBodies: () => {},
    showAllPlanes: () => {},
    setPatternGhost: () => {},
    clearPatternGhost: () => {},
    hoverBody: () => {},
    hoverPlane: () => {},
    highlightDatum: () => {},
    setFaceMarks: () => {},
    hoverDatum: () => {},
    hoverFaceAt: () => {},
    clearHover: () => {},
    ...faceRowViewport().parts,
  } as unknown as Viewport;
  const addFeatures = vi.spyOn(r.store, "addFeatures").mockImplementation(() => {});
  const done = vi.fn();
  tool = new MirrorTool(viewport, r.store, () => null);
  stops.push(() => tool!.cancel());
  tool.start(["body1"], done);
  return { r, tool, addFeatures, done };
}

const panel = () => {
  const v = useToolPanelStore().mirror;
  return v && { values: v.fields.map((f) => f.value), ready: v.ready };
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(announce).mockClear();
  canvas = document.createElement("canvas");
  canvas.tabIndex = 0;
  document.body.replaceChildren(canvas);
  canvas.focus();
});
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
  resetTreePicks();
  document.body.replaceChildren();
});

describe("Mirror waiting for its plane", () => {
  it("Enter gives it the lit flat face without mirroring, the next Enter is Mirror's own", async () => {
    const { r, addFeatures, done } = await mirrorWaiting();
    expect(key("]").defaultPrevented).toBe(true);
    expect(r.list.cursor).toBe("f:body1:0");
    expect(panel()).toEqual({ values: ["1 body", "Nothing picked"], ready: false });

    expect(key("Enter").defaultPrevented).toBe(true);
    expect(panel()).toEqual({ values: ["1 body", "Flat face"], ready: true });
    expect(addFeatures).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    expect(r.list.litRow).toBeNull();
    const word = t("pick.done", { name: "", done: "mirrorPlane" }).trim();
    expect(said().filter((w) => w.endsWith(word))).toHaveLength(1);

    expect(key("Enter").defaultPrevented).toBe(true);
    expect(addFeatures).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("a curved face is refused aloud, the tool still waits and the next Enter has no row to give", async () => {
    const { r, addFeatures } = await mirrorWaiting();
    key("]");
    key("]");
    expect(r.list.cursor).toBe("f:body1:1");
    key("Enter");
    expect(panel()).toEqual({ values: ["1 body", "Nothing picked"], ready: false });
    expect(treePickWaiting()).toBe(true);
    expect(r.list.litRow).toBeNull();
    expect(addFeatures).not.toHaveBeenCalled();
    expect(said().at(-1)).not.toContain(t("pick.done", { name: "", done: "mirrorPlane" }).trim());
  });

  it("the next ] goes on from the row just offered", async () => {
    const { r } = await mirrorWaiting();
    key("]");
    key("Enter");
    key("]");
    expect(r.list.cursor).toBe("f:body1:1");
    expect(r.list.litRow?.key).toBe("f:body1:1");
  });
});

// Slanted, off origin edges of body1, none sharing an end, so each row is its own chain.
const FILLET_EDGES = [edge("body1", 0, 4), edge("body1", 1, 4), edge("body1", 2, 4)];

async function filletWaiting() {
  const r = rig(result([{ id: "body1", etag: "e1", faceStart: 14 }]));
  let tool: EdgeFeatureTool | null = null;
  const host = {
    ...r.host,
    geometryBrowser: r.browser,
    viewport: { domElement: canvas },
    toolOwnsScreen: () => tool?.active ?? false,
  };
  stops.push(installCanvasPick(host as unknown as CanvasPickHost));
  await r.build();
  r.wires.set("body1", FILLET_EDGES);
  key("}");
  await land(r.asks[0]!, topology("body1", 3));
  expect(r.list.kind).toBe("edges");

  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, -100, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const own: Record<string, unknown> = {
    domElement: canvas,
    camera,
    suspendPicking: false,
    selectedEdgeSeeds: () => [],
    selectedEdgeCount: () => 0,
    edgesOfSelectedFaces: () => [],
    edgeScopeView: () => ({ edgePx: 60, viewportPx: 800, pixelWorldSize: 0.1, modelDiagonal: 500 }),
    pixelWorldSize: () => 0.1,
    projectToScreen: () => ({ x: 100, y: 100 }),
    modelDiagonal: () => 500,
    visibleEdgeLines: () => FILLET_EDGES,
  };
  const viewport = new Proxy(own, {
    get: (t, k) => (k in t ? t[k as string] : () => undefined),
  }) as unknown as Viewport;
  const addFeature = vi.spyOn(r.store, "addFeature").mockImplementation(() => {});
  const done = vi.fn();
  tool = new EdgeFeatureTool(viewport, r.store);
  stops.push(() => tool!.cancel());
  tool.start("fillet", done);
  return { r, tool, addFeature, done };
}

describe("Fillet waiting for an edge", () => {
  it("Enter adds the lit edge without committing, a second adds another, the lit first comes out, the next Enter commits", async () => {
    const { r, tool, addFeature, done } = await filletWaiting();
    expect(key("]").defaultPrevented).toBe(true);
    expect(r.list.cursor).toBe("e:body1:0");
    expect(key("Enter").defaultPrevented).toBe(true);
    expect(tool.memberRows()).toHaveLength(1);
    expect(addFeature).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    expect(r.list.litRow).toBeNull();
    const added = t("pick.done", { name: "", done: "added" }).trim();
    expect(said().filter((w) => w.endsWith(added))).toHaveLength(1);

    key("]");
    expect(r.list.cursor).toBe("e:body1:1");
    key("Enter");
    expect(tool.memberRows()).toHaveLength(2);

    key("[");
    expect(r.list.cursor).toBe("e:body1:0");
    key("Enter");
    expect(tool.memberRows()).toHaveLength(1);
    const out = t("pick.done", { name: "", done: "takenOut" }).trim();
    expect(said().filter((w) => w.endsWith(out))).toHaveLength(1);
    expect(addFeature).not.toHaveBeenCalled();

    expect(key("Enter").defaultPrevented).toBe(true);
    expect(addFeature).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("a held Enter's repeats that land on the radius box the take focused do not commit", async () => {
    const { tool, addFeature, done } = await filletWaiting();
    key("]");
    key("Enter");
    expect(document.activeElement?.tagName).toBe("INPUT");
    for (let i = 0; i < 3; i++) expect(repeatOnFocus("Enter").defaultPrevented).toBe(true);
    expect([tool.memberRows().length, addFeature.mock.calls.length, done.mock.calls.length]).toEqual([1, 0, 0]);
  });
});

async function textWaiting() {
  const r = rig(result([{ id: "body1", etag: "e1", faceStart: 14 }]));
  let tool: TextOnFaceTool | null = null;
  const host = {
    ...r.host,
    geometryBrowser: r.browser,
    viewport: { domElement: canvas },
    toolOwnsScreen: () => tool?.active ?? false,
  };
  stops.push(installCanvasPick(host as unknown as CanvasPickHost));
  await r.build();
  r.browser.show(true);
  await land(r.asks[0]!, topology("body1", 3));
  r.browser.show(false);

  const own: Record<string, unknown> = {
    domElement: canvas,
    suspendPicking: false,
    projectToScreen: () => ({ x: 120, y: 340 }),
    ...faceRowViewport().parts,
  };
  const viewport = new Proxy(own, {
    get: (t, k) => (k in t ? t[k as string] : () => undefined),
  }) as unknown as Viewport;
  const anchors: unknown[][] = [];
  const surfaces: string[] = [];
  vi.spyOn(r.store, "faceAnchor").mockImplementation((...a) => {
    anchors.push(a);
    const surface = surfaces.shift() ?? "plane";
    return Promise.resolve({ body: "b2", surface, at: [0.5, 0.5], normal: asVec(SLANT_NORMAL) } as FaceAnchorReply);
  });
  vi.spyOn(r.store, "setPreview").mockImplementation(() => {});
  const addFeatures = vi.spyOn(r.store, "addFeatures").mockImplementation(() => {});
  const done = vi.fn();
  tool = new TextOnFaceTool(viewport, r.store);
  stops.push(() => tool!.cancel());
  tool.start(done);
  return { r, tool, anchors, surfaces, addFeatures, done };
}

describe("Text on face waiting for its face", () => {
  it("Enter on the lit face starts the anchor ask for it, and Enter does not commit anything before the text is typed", async () => {
    const { r, anchors, addFeatures, done } = await textWaiting();
    expect(key("]").defaultPrevented).toBe(true);
    expect(r.list.cursor).toBe("f:body1:0");
    expect(anchors).toEqual([]);

    expect(key("Enter").defaultPrevented).toBe(true);
    expect(anchors).toEqual([
      [{ kind: "face", by: "nearest", point: asVec(FLAT_ANCHOR), body: "b2" }, "b2", asVec(FLAT_ANCHOR)],
    ]);
    expect(r.list.litRow).toBeNull();
    const picked = said().filter((w) => w.endsWith(" picked"));
    expect(picked).toHaveLength(1);

    await new Promise((res) => setTimeout(res, 0));
    expect(useToolPanelStore().text).not.toBeNull();
    expect(addFeatures).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    expect(treePickWaiting()).toBe(false);
  });

  it("a held Enter's repeats that land on the text box the take focused do not commit", async () => {
    const { addFeatures, done } = await textWaiting();
    key("]");
    key("Enter");
    await new Promise((res) => setTimeout(res, 0));
    expect(document.activeElement).not.toBe(canvas);
    expect(document.activeElement).not.toBe(document.body);
    for (let i = 0; i < 3; i++) expect(repeatOnFocus("Enter").defaultPrevented).toBe(true);
    await new Promise((res) => setTimeout(res, 0));
    expect([addFeatures.mock.calls.length, done.mock.calls.length]).toEqual([0, 0]);
  });

  it("a face the engine calls a sphere keeps the tool waiting, and the next lit face is asked as well", async () => {
    const { r, anchors, surfaces, tool, addFeatures } = await textWaiting();
    surfaces.push("sphere");
    key("]");
    key("]");
    key("]");
    expect(r.list.cursor).toBe("f:body1:2");
    key("Enter");
    await new Promise((res) => setTimeout(res, 0));
    expect(anchors).toHaveLength(1);
    expect([treePickWaiting(), tool.active, useToolPanelStore().text]).toEqual([true, true, null]);

    key("[");
    key("Enter");
    await new Promise((res) => setTimeout(res, 0));
    expect(anchors).toHaveLength(2);
    expect([treePickWaiting(), useToolPanelStore().text === null]).toEqual([false, false]);
    expect(addFeatures).not.toHaveBeenCalled();
  });
});
