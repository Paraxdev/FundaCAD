// The readout and the speech of a selection, over a real DocumentStore and Geometry list controller.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { defineComponent, nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import type { Engine } from "../../src/app/engine";
import { useSelectionOffers } from "../../src/composables/useSelectionOffers";
import { SessionEnded } from "../../src/document/session";
import { useSelectionStore } from "../../src/stores/selection";
import { describePick } from "../../src/ui/describePick";
import { exactRound } from "../../src/ui/selectionMeasure";
import { setUnit } from "../../src/ui/units";
import { edge, land, result, rig, settle, topology } from "../app/geometryBrowserRig";

vi.mock("../../src/ui/toast", () => ({ toast: () => {}, dismissToast: () => {} }));

enableAutoUnmount(afterEach);

const SECOND = {
  parameters: {},
  features: [{ id: "g1", type: "box", name: "Other block", length: 7, width: 9, height: 11 }],
};

let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  setActivePinia(createPinia());
  frames = [];
  exactRound.value = null;
  setUnit("mm");
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(first?: Parameters<typeof rig>[0]) {
  const r = rig(first);
  const regions: { interior3D: { x: number } }[] = [];
  const press = vi.fn((): unknown => null);
  const planar = vi.fn((_id: number): { normal: THREE.Vector3; origin: THREE.Vector3 } | null => null);
  const owned = { tool: false };
  Object.assign(r.viewport, {
    selectedFacesForPressPull: press,
    planarFace: planar,
    clearSelection: vi.fn(),
    requestRender: vi.fn(),
  });
  const engine = {
    ...r.host,
    geometryBrowser: r.browser,
    overlay: { selectedRegions: () => regions, clearRegionSelection: vi.fn() },
    toolOwnsScreen: () => owned.tool,
  } as unknown as Engine;
  let sel!: ReturnType<typeof useSelectionOffers>;
  const wrapper = mount(
    defineComponent({
      setup() {
        sel = useSelectionOffers(engine, { words: true });
        return () => null;
      },
    }),
  );
  const now = { value: 5000 };
  vi.spyOn(performance, "now").mockImplementation(() => now.value);
  const frame = async () => {
    const due = frames;
    frames = [];
    for (const cb of due) cb(0);
    await nextTick();
  };
  // A pointer or key release is what wakes the readout once it has gone idle.
  const settled = async () => {
    window.dispatchEvent(new Event("keyup"));
    await frame();
  };
  return { ...r, wrapper, sel, press, planar, regions, owned, now, frame, settled };
}

describe("the readout of one face", () => {
  it("takes a listed row's facts and reads no mesh", async () => {
    const r = setup();
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, topology("body1"));
    r.selection.faces = [1];
    await r.settled();
    expect(r.sel.readout.value).toBe("1 face · flat · 41 by 6 mm · facing up");
    expect(r.sel.speech.value?.text).toMatch(/^Flat face 2, 41 by 6 millimetres, 25 square millimetres, facing up/);
    expect(r.sel.speech.value?.text).not.toMatch(/\bmm\b|·|⌀|²/);
    expect(r.planar).not.toHaveBeenCalled();
    expect(r.press).not.toHaveBeenCalled();
  });

  it("does not trust a row from before a build, its number may mean another face", async () => {
    const r = setup();
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, topology("body1"));
    await r.build(
      result([
        { id: "body1", etag: "e9" },
        { id: "body2", etag: "e2" },
      ]),
    );
    r.selection.faces = [1];
    await r.settled();
    expect(r.sel.readout.value).toBe("1 face · curved");
  });

  it("reads a flat face from the mesh when no row holds it, tilted and off the origin", async () => {
    const r = setup();
    await r.build();
    r.planar.mockReturnValue({
      normal: new THREE.Vector3(0.6, -0.8, 0),
      origin: new THREE.Vector3(113.5, -41.25, 37),
    });
    r.selection.faces = [4];
    await r.settled();
    expect(r.sel.readout.value).toBe("1 face · flat · tilted 37° from front");
    expect(r.sel.speech.value?.text).toBe("Flat face 2, tilted 37 degrees from front, BODY2");
    expect(r.planar.mock.calls).toEqual([[4]]);
  });

  it("gives a level face from the mesh its height", async () => {
    const r = setup();
    await r.build();
    r.planar.mockReturnValue({ normal: new THREE.Vector3(0, 0, 1), origin: new THREE.Vector3(113.5, -41.25, 37) });
    r.selection.faces = [0];
    await r.settled();
    expect(r.sel.speech.value?.text).toBe("Flat face 1, facing up, at height 37 millimetres, BODY1");
  });

  it.each([
    [
      { radius: 25, full: true, solidInside: false },
      "1 face · hole · ⌀50 mm",
      "Hole 1, diameter 50 millimetres, BODY1",
    ],
    [
      { radius: 25, full: true, solidInside: true },
      "1 face · cylinder · ⌀50 mm",
      "Cylinder 1, diameter 50 millimetres, BODY1",
    ],
    [
      { radius: 2.5, full: false, solidInside: true },
      "1 face · round · R2.5 mm",
      "Round face 1, radius 2.5 millimetres, BODY1",
    ],
    [
      { radius: 9, solidInside: true, centre: [3, 4, 5] },
      "1 face · sphere · ⌀18 mm",
      "Sphere 1, diameter 18 millimetres, BODY1",
    ],
  ])("reads a round face from the mesh", async (round, screen, said) => {
    const r = setup();
    await r.build();
    r.press.mockReturnValue({ faceIds: [0], round, lead: null });
    r.selection.faces = [0];
    await r.settled();
    expect(r.sel.readout.value).toBe(screen);
    expect(r.sel.speech.value?.text).toBe(said);
    expect(r.planar).not.toHaveBeenCalled();
  });

  it("says a face the mesh cannot name is curved", async () => {
    const r = setup();
    await r.build();
    r.selection.faces = [2];
    await r.settled();
    expect(r.sel.readout.value).toBe("1 face · curved");
    expect(r.sel.speech.value?.text).toBe("Curved face 3, BODY1");
  });

  it("names the step a face came from in speech, not on screen", async () => {
    const r = setup(result([{ id: "body1", etag: "e1", faceOwners: ["f1", null, null] }]));
    await r.build();
    r.selection.faces = [0];
    await r.settled();
    expect(r.sel.readout.value).toBe("1 face · curved");
    expect(r.sel.speech.value?.text).toBe("Curved face 1, BODY1, from Base block");
  });

  it("shows the engine's exact radius once press and pull has it, for that face alone", async () => {
    const r = setup();
    await r.build();
    r.press.mockReturnValue({ faceIds: [1], round: { radius: 25.04, full: true, solidInside: false }, lead: null });
    r.selection.faces = [1];
    await r.settled();
    expect(r.sel.readout.value).toBe("1 face · hole · ⌀50.08 mm");
    exactRound.value = { faceId: 2, radius: 30, full: true };
    await nextTick();
    expect(r.sel.readout.value).toBe("1 face · hole · ⌀50.08 mm");
    exactRound.value = { faceId: 1, radius: 25, full: true };
    await nextTick();
    expect(r.sel.readout.value).toBe("1 face · hole · ⌀50 mm");
  });

  it("follows the display unit", async () => {
    const r = setup();
    await r.build();
    setUnit("cm");
    r.press.mockReturnValue({ faceIds: [0], round: { radius: 25, full: true, solidInside: false }, lead: null });
    r.selection.faces = [0];
    await r.settled();
    expect(r.sel.readout.value).toBe("1 face · hole · ⌀5 cm");
    expect(r.sel.speech.value?.text).toBe("Hole 1, diameter 5 centimetres, BODY1");
  });

  it("counts the pieces of one split surface as one face", async () => {
    const r = setup(result([{ id: "body1", etag: "e1", faceCount: 6, faceBands: [[1, 3]] }]));
    await r.build();
    r.selection.faces = [1, 3];
    await r.settled();
    expect(r.sel.readout.value).toBe("1 face · curved");
    expect(r.sel.speech.value?.text).toBe("Curved face 2, in 2 pieces, BODY1");
    r.selection.faces = [1, 3, 5];
    await r.settled();
    expect(r.sel.readout.value).toBe("2 faces");
    expect(r.sel.speech.value?.text).toBe("Face 6 added, 2 selected");
  });
});

describe("the readout of edges and bodies", () => {
  it("reads one edge from its wire, a length and a type", async () => {
    const r = setup();
    await r.build();
    r.selection.edges = [edge("body2", 7, 12)];
    await r.settled();
    const long = Math.hypot(20, 5);
    expect(r.sel.readout.value).toBe(`1 edge · straight · ${Number(long.toFixed(2))} mm`);
    expect(r.sel.speech.value?.text).toBe(`Straight edge 8, ${Number(long.toFixed(2))} millimetres, BODY2`);
  });

  it("totals several edges in the display unit", async () => {
    const r = setup();
    await r.build();
    setUnit("cm");
    r.selection.edges = [edge("body2", 7, 12), edge("body2", 8, 12), edge("body1", 1, 3)];
    await r.settled();
    const total = Math.hypot(20, 5) * 3;
    expect(r.sel.readout.value).toBe(`3 edges · ${Number((total / 10).toFixed(2))} cm`);
    expect(r.sel.speech.value?.text).toBe("3 edges selected");
  });

  it("keeps the pointer hint off speech under Auto, and off both under Faces", async () => {
    const r = setup();
    await r.build();
    r.selection.bodies = ["body2"];
    await r.settled();
    expect(r.sel.readout.value).toBe("1 body · click again for a face, or pause over it");
    expect(r.sel.speech.value?.text).toBe("BODY2");
    r.viewport.policy = "faces";
    r.selection.bodies = ["body1", "body2"];
    await r.settled();
    expect(r.sel.readout.value).toBe("2 bodies");
    expect(r.sel.speech.value?.text).toBe("BODY1 added, 2 selected");
  });

  it("counts many bodies and profiles by their own nouns", async () => {
    const r = setup();
    await r.build();
    r.selection.bodies = ["body1", "body2"];
    r.regions.push({ interior3D: { x: 3.5 } }, { interior3D: { x: -8.25 } });
    await r.settled();
    expect(r.sel.speech.value?.text).toBe("2 bodies, 2 profiles selected");
  });
});

describe("what a change says", () => {
  it("says a face added or removed by its plain number when no row holds it, and its body apart", async () => {
    const r = setup();
    await r.build();
    r.selection.faces = [0];
    await r.settled();
    r.press.mockClear();
    r.planar.mockClear();
    r.selection.faces = [0, 3];
    await r.settled();
    expect(r.sel.speech.value?.text).toBe("Face 1 of BODY2 added, 2 selected");
    r.selection.faces = [3];
    await r.settled();
    expect(r.sel.speech.value?.text).toBe("Face 1 of BODY1 removed, 1 selected");
  });

  it("walks no mesh for a face added to others", async () => {
    const r = setup();
    await r.build();
    r.selection.faces = [0, 1];
    await r.settled();
    r.selection.faces = [0, 1, 2];
    await r.settled();
    expect(r.sel.speech.value?.text).toBe("Face 3 added, 3 selected");
    expect(r.planar).not.toHaveBeenCalled();
    expect(r.press).not.toHaveBeenCalled();
  });

  it("says a listed row's type when it is added", async () => {
    const r = setup();
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, topology("body1"));
    r.selection.faces = [0];
    await r.settled();
    r.selection.faces = [0, 2];
    await r.settled();
    expect(r.sel.speech.value?.text).toBe("Flat face 3 added, 2 selected");
  });

  it("names an added edge from its wire, and a removed one by number", async () => {
    const r = setup();
    await r.build();
    r.selection.edges = [edge("body1", 0, 3)];
    await r.settled();
    r.selection.edges = [edge("body1", 0, 3), edge("body1", 2, 3)];
    await r.settled();
    expect(r.sel.speech.value?.text).toBe("Straight edge 3 added, 2 selected");
    r.selection.edges = [edge("body1", 2, 3)];
    await r.settled();
    expect(r.sel.speech.value?.text).toBe("Edge 1 removed, 1 selected");
  });

  it("speaks once per change, not on the frames between", async () => {
    const r = setup();
    await r.build();
    r.selection.faces = [0];
    await r.settled();
    const said = r.sel.speech.value;
    await r.frame();
    await r.frame();
    expect(r.sel.speech.value).toBe(said);
  });

  it("stays quiet when a build keeps the selection, even as its ids shift", async () => {
    const r = setup();
    await r.build();
    r.selection.faces = [4];
    await r.settled();
    const said = r.sel.speech.value;
    await r.build(
      result([
        { id: "body1", etag: "e1", faceCount: 5 },
        { id: "body2", etag: "e2" },
      ]),
    );
    r.selection.faces = [6];
    await r.settled();
    expect(r.sel.speech.value).toBe(said);
  });

  it("says Nothing selected at Verbose alone when the selection just goes", async () => {
    const r = setup();
    await r.build();
    r.selection.faces = [0];
    await r.settled();
    r.selection.faces = [];
    await r.settled();
    expect(r.sel.speech.value).toEqual({ text: "Nothing selected", verbose: true });
    expect(r.sel.readout.value).toBe("");
  });

  it("says nothing with nothing selected from the start", async () => {
    const r = setup();
    await r.build();
    await r.settled();
    expect(r.sel.speech.value).toBeNull();
    expect(r.sel.readout.value).toBe("");
  });

  it("leaves a tool's picks to the tool, then says what stays selected once", async () => {
    const r = setup();
    await r.build();
    r.selection.faces = [0];
    await r.settled();
    r.owned.tool = true;
    await r.settled();
    expect(r.sel.speech.value).toBeNull();
    r.selection.faces = [0, 1];
    await r.settled();
    expect(r.sel.speech.value).toBeNull();
    r.owned.tool = false;
    await r.settled();
    expect(r.sel.speech.value?.text).toBe("2 faces selected");
    const said = r.sel.speech.value;
    await r.frame();
    expect(r.sel.speech.value).toBe(said);
  });

  it("is silent when a tool ends with nothing selected", async () => {
    const r = setup();
    await r.build();
    r.selection.faces = [0];
    await r.settled();
    r.owned.tool = true;
    await r.settled();
    r.selection.faces = [];
    await r.settled();
    r.owned.tool = false;
    await r.settled();
    expect(r.sel.speech.value).toBeNull();
  });

  it("carries no first document's words into a second with the same body id", async () => {
    const r = setup();
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, topology("body1"));
    r.selection.faces = [0];
    await r.settled();
    expect(r.sel.readout.value).toBe("1 face · flat · 40 by 6 mm · facing up");
    r.selection.faces = [];
    await r.settled();
    r.store.load(JSON.stringify(SECOND));
    await r.build(result([{ id: "body1", etag: "other", name: "Other" }]));
    r.browser.show(false);
    r.selection.faces = [0];
    await r.settled();
    expect(r.sel.readout.value).toBe("1 face · curved");
    expect(r.sel.speech.value?.text).toBe("Curved face 1, Other");
  });

  it("the other users of the composable read no words", async () => {
    const r = setup();
    await r.build();
    let plain!: ReturnType<typeof useSelectionOffers>;
    mount(
      defineComponent({
        setup() {
          plain = useSelectionOffers({
            ...r.host,
            overlay: { selectedRegions: () => [] },
            geometryBrowser: r.browser,
          } as unknown as Engine);
          return () => null;
        },
      }),
    );
    await settle();
    r.selection.faces = [0];
    await r.settled();
    expect(plain.summary.value).toBe("1 face");
    expect(plain.speech.value).toBeNull();
    expect(r.press.mock.calls.length).toBe(1);
  });
});

describe("the engine's answer for a lone face", () => {
  const face = (i: number) => ({
    i,
    surface: "cylinder" as const,
    area: 628.5,
    radius: 5,
    wraps: true,
    concave: true,
    length: 20,
    axis: [0, 0.6, 0.8] as [number, number, number],
    centroid: [113.5, -41.25, 37] as [number, number, number],
  });
  const reply = (body: string, ...i: number[]) => ({ body, faceCount: 3, faces: i.map(face) });

  it("asks for that face only and replaces the mesh's words on screen and in speech", async () => {
    const r = setup();
    await r.build();
    r.selection.faces = [4];
    await r.settled();
    expect(r.sel.readout.value).toBe("1 face · curved");
    expect(r.asks.map((a) => [a.body, a.opts])).toEqual([["body2", { faces: [1] }]]);
    await land(r.asks[0]!, reply("body2", 1));
    expect(r.sel.readout.value).toBe("1 face · hole · ⌀10 mm · 20 mm long");
    expect(r.sel.speech.value?.text).toMatch(/^Hole 2, diameter 10 millimetres, 20 millimetres long, axis/);
    expect(r.asks).toHaveLength(1);
  });

  it("asks for every piece of one split surface and reads them as one", async () => {
    const r = setup(result([{ id: "body1", etag: "e1", faceCount: 6, faceBands: [[1, 3]] }]));
    await r.build();
    r.selection.faces = [1, 3];
    await r.settled();
    expect(r.asks.map((a) => a.opts)).toEqual([{ faces: [1, 3] }]);
    await land(r.asks[0]!, reply("body1", 1, 3));
    expect(r.sel.speech.value?.text).toContain("Hole 2");
    expect(r.sel.speech.value?.text).toContain("in 2 pieces");
  });

  it("drops the reply for a selection that has moved on", async () => {
    const r = setup();
    await r.build();
    r.selection.faces = [0];
    await r.settled();
    r.planar.mockReturnValue({ normal: new THREE.Vector3(0, 0, -1), origin: new THREE.Vector3(3, 4, 5) });
    r.selection.faces = [1];
    await r.settled();
    await land(r.asks[0]!, reply("body1", 0));
    expect(r.sel.readout.value).toBe("1 face · flat · facing down");
    expect(r.sel.speech.value?.text).toMatch(/^Flat face 2/);
    await land(r.asks[1]!, reply("body1", 1));
    expect(r.sel.readout.value).toBe("1 face · hole · ⌀10 mm · 20 mm long");
  });

  it("drops the reply once the selection has gone", async () => {
    const r = setup();
    await r.build();
    r.selection.faces = [0];
    await r.settled();
    r.selection.faces = [];
    await r.settled();
    await land(r.asks[0]!, reply("body1", 0));
    expect(r.sel.readout.value).toBe("");
    expect(r.sel.speech.value?.text).toBe("Nothing selected");
  });

  it("soft cancels an ask the next click supersedes, and leaves an answered one alone", async () => {
    const r = setup();
    await r.build();
    r.cancel.mockClear();
    r.selection.faces = [0];
    await r.settled();
    r.selection.faces = [1];
    await r.settled();
    expect(r.cancel.mock.calls).toEqual([["req1", { soft: true }]]);
    await land(r.asks[1]!, reply("body1", 1));
    r.selection.faces = [];
    await r.settled();
    expect(r.cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels no ask on an engine without a soft cancel, a hard one would restart it", async () => {
    const r = setup();
    await r.build();
    (r.host.geometry as { softCancel: boolean }).softCancel = false;
    r.cancel.mockClear();
    r.selection.faces = [0];
    await r.settled();
    r.selection.faces = [1];
    await r.settled();
    expect(r.cancel).not.toHaveBeenCalled();
  });

  it("drops the reply from before a build and asks again, without speaking", async () => {
    const r = setup();
    await r.build();
    r.selection.faces = [0];
    await r.settled();
    const said = r.sel.speech.value;
    await r.build(
      result([
        { id: "body1", etag: "e7" },
        { id: "body2", etag: "e2" },
      ]),
    );
    await land(r.asks[0]!, reply("body1", 0));
    expect(r.sel.readout.value).toBe("1 face · curved");
    await r.settled();
    expect(r.asks).toHaveLength(2);
    r.now.value += 100;
    await land(r.asks[1]!, reply("body1", 0));
    expect(r.sel.readout.value).toBe("1 face · hole · ⌀10 mm · 20 mm long");
    expect(r.sel.speech.value).toBe(said);
  });

  it("speaks a reply inside the wait, up to its last moment, and only shows a later one", async () => {
    for (const [late, spoken] of [
      [249, true],
      [250, false],
    ] as const) {
      const r = setup();
      await r.build();
      r.selection.faces = [0];
      await r.settled();
      const first = r.sel.speech.value;
      r.now.value += late;
      await land(r.asks[0]!, reply("body1", 0));
      expect(r.sel.readout.value).toBe("1 face · hole · ⌀10 mm · 20 mm long");
      if (spoken) expect(r.sel.speech.value?.text).toMatch(/^Hole 1/);
      else expect(r.sel.speech.value).toBe(first);
    }
  });

  it("leaves added and removed speech alone when the reply comes", async () => {
    const r = setup();
    await r.build();
    r.selection.faces = [0, 1];
    await r.settled();
    r.selection.faces = [0];
    await r.settled();
    expect(r.sel.speech.value?.text).toBe("Face 2 removed, 1 selected");
    await land(r.asks[0]!, reply("body1", 0));
    expect(r.sel.speech.value?.text).toBe("Face 2 removed, 1 selected");
    expect(r.sel.readout.value).toBe("1 face · hole · ⌀10 mm · 20 mm long");
  });

  it("asks nothing for a listed face, several faces, an edge or a body", async () => {
    const r = setup();
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, topology("body1"));
    r.asks.length = 0;
    r.selection.faces = [1];
    await r.settled();
    r.selection.faces = [3, 4];
    await r.settled();
    r.selection.faces = [];
    r.selection.edges = [edge("body1", 2, 3)];
    await r.settled();
    r.selection.edges = [];
    r.selection.bodies = ["body2"];
    await r.settled();
    expect(r.asks).toEqual([]);
  });

  it("asks nothing while a tool owns the screen, and asks when it ends", async () => {
    const r = setup();
    await r.build();
    r.owned.tool = true;
    r.selection.faces = [1];
    await r.settled();
    expect(r.asks).toEqual([]);
    r.owned.tool = false;
    await r.settled();
    expect(r.asks.map((a) => a.opts)).toEqual([{ faces: [1] }]);
  });

  it("drops a reply when a tool has taken over", async () => {
    const r = setup();
    await r.build();
    r.selection.faces = [1];
    await r.settled();
    r.owned.tool = true;
    await r.settled();
    await land(r.asks[0]!, reply("body1", 1));
    expect(r.sel.speech.value).toBeNull();
    expect(r.sel.readout.value).toBe("1 face · curved");
  });

  it("asks nothing during a preview, the settled build asks", async () => {
    const r = setup();
    await r.build();
    const real = r.store.buildState;
    const spy = vi.spyOn(r.store, "buildState", "get").mockReturnValue({ ...real, previewBuilt: [] });
    r.selection.faces = [1];
    await r.settled();
    expect(r.asks).toEqual([]);
    spy.mockRestore();
    await r.build(
      result([
        { id: "body1", etag: "e5" },
        { id: "body2", etag: "e2" },
      ]),
    );
    await r.settled();
    expect(r.asks.map((a) => a.opts)).toEqual([{ faces: [1] }]);
  });

  it("keeps the mesh's words when the engine cannot answer or the request ends", async () => {
    const r = setup();
    await r.build();
    r.selection.faces = [0];
    await r.settled();
    await land(r.asks[0]!, null);
    expect(r.sel.readout.value).toBe("1 face · curved");
    r.selection.faces = [1];
    await r.settled();
    r.asks[1]!.fail(new SessionEnded());
    await settle();
    expect(r.sel.readout.value).toBe("1 face · curved");
    r.selection.faces = [2];
    await r.settled();
    await land(r.asks[2]!, reply("body1", 7));
    expect(r.sel.readout.value).toBe("1 face · curved");
  });

  it("drops a first document's reply in a second document with the same body id", async () => {
    const r = setup();
    await r.build();
    r.selection.faces = [0];
    await r.settled();
    r.selection.faces = [];
    await r.settled();
    r.store.load(JSON.stringify(SECOND));
    await r.build(result([{ id: "body1", etag: "other", name: "Other" }]));
    r.selection.faces = [0];
    await r.settled();
    r.asks[0]!.answer(reply("body1", 0));
    await settle();
    expect(r.sel.readout.value).toBe("1 face · curved");
    expect(r.asks).toHaveLength(2);
    expect(r.asks[1]!.doc.features.map((f) => f.id)).toEqual(["g1"]);
    await land(r.asks[1]!, reply("body1", 0));
    expect(r.sel.readout.value).toBe("1 face · hole · ⌀10 mm · 20 mm long");
    expect(r.sel.speech.value?.text).toContain("Other");
  });
});

describe("Escape", () => {
  const escape = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

  it("says Nothing selected at every verbosity when it clears the selection", async () => {
    const r = setup();
    await r.build();
    r.selection.faces = [3];
    await r.settled();
    escape();
    r.selection.faces = [];
    await r.frame();
    expect(r.sel.speech.value).toEqual({ text: "Nothing selected" });
  });

  it("hears the key even when a field stops it on its way up", async () => {
    const r = setup();
    await r.build();
    r.selection.edges = [edge("body1", 2, 3)];
    await r.settled();
    const field = document.body.appendChild(document.createElement("input"));
    field.addEventListener("keydown", (ev) => ev.stopPropagation());
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    field.remove();
    r.selection.edges = [];
    await r.frame();
    expect(r.sel.speech.value).toEqual({ text: "Nothing selected" });
  });

  it("says nothing when it leaves the selection, and a later plain clear is Verbose alone", async () => {
    const r = setup();
    await r.build();
    r.selection.faces = [3];
    await r.settled();
    const said = r.sel.speech.value;
    escape();
    await r.frame();
    expect(r.sel.speech.value).toBe(said);
    r.selection.faces = [];
    await r.frame();
    expect(r.sel.speech.value).toEqual({ text: "Nothing selected", verbose: true });
  });

  it("with nothing selected says nothing, and does not mark the next clear", async () => {
    const r = setup();
    await r.build();
    escape();
    await r.settled();
    expect(r.sel.speech.value).toBeNull();
    r.selection.faces = [3];
    await r.settled();
    r.selection.faces = [];
    await r.settled();
    expect(r.sel.speech.value).toEqual({ text: "Nothing selected", verbose: true });
  });

  it("another key does not count", async () => {
    const r = setup();
    await r.build();
    r.selection.faces = [3];
    await r.settled();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" }));
    r.selection.faces = [];
    await r.frame();
    expect(r.sel.speech.value).toEqual({ text: "Nothing selected", verbose: true });
  });

  it("is the tool's while a tool owns the screen", async () => {
    const r = setup();
    await r.build();
    r.selection.faces = [3];
    await r.settled();
    r.owned.tool = true;
    await r.settled();
    escape();
    r.selection.faces = [];
    r.owned.tool = false;
    await r.frame();
    expect(r.sel.speech.value).toBeNull();
  });

  it("leaves no listener behind", async () => {
    const r = setup();
    const off = vi.spyOn(window, "removeEventListener");
    r.wrapper.unmount();
    expect(off.mock.calls.filter((c) => c[0] === "keydown" && c[2] === true)).toHaveLength(1);
  });
});

describe("planes", () => {
  const LID = {
    id: "d1",
    type: "datumPlane",
    name: "Lid",
    plane: { origin: [12, -7, 31], normal: [0.6, 0, 0.8], xDir: [0.8, 0, -0.6] },
  };
  const WITH_LID = { parameters: {}, features: [SECOND.features[0], LID] };
  const pickRows = (keys: string[]) => (useSelectionStore().rows = { keys, anchor: keys.at(-1) ?? null });

  it("reads one origin plane in words, off a row, with no key hint in speech", async () => {
    const r = setup();
    await r.build();
    pickRows(["o:XZ"]);
    await nextTick();
    await r.frame();
    expect(r.sel.readout.value).toBe("XZ plane · origin · facing front");
    expect(r.sel.speech.value).toEqual({ text: "XZ plane, origin, facing front" });
  });

  it("reads a slanted datum by its name", async () => {
    const r = setup();
    r.store.load(JSON.stringify(WITH_LID));
    await r.build();
    pickRows(["d1"]);
    await nextTick();
    await r.frame();
    expect(r.sel.readout.value).toBe("Lid · datum plane · tilted 37° from up");
    expect(r.sel.speech.value?.text).toBe("Lid, datum plane, tilted 37° from up");
  });

  it("ignores a feature row that is no plane, a suppressed datum and one the document lost", async () => {
    const r = setup();
    r.store.load(JSON.stringify(WITH_LID));
    await r.build();
    pickRows(["g1"]);
    await nextTick();
    await r.frame();
    expect(r.sel.readout.value).toBe("");
    expect(r.sel.speech.value).toBeNull();
    r.store.isSuppressed = (id: string) => id === "d1";
    pickRows(["d1"]);
    await nextTick();
    await r.frame();
    expect(r.sel.speech.value).toBeNull();
    r.store.load(JSON.stringify(SECOND));
    await r.build();
    pickRows(["d1"]);
    await nextTick();
    await r.frame();
    expect(r.sel.readout.value).toBe("");
    expect(r.sel.speech.value).toBeNull();
  });

  it("counts several, says one added or removed, and counts them with other picks", async () => {
    const r = setup();
    await r.build();
    pickRows(["o:XY"]);
    await nextTick();
    await r.frame();
    pickRows(["o:XY", "o:YZ"]);
    await nextTick();
    await r.frame();
    expect(r.sel.readout.value).toBe("2 planes");
    expect(r.sel.speech.value?.text).toBe("YZ plane added, 2 selected");
    pickRows(["o:YZ"]);
    await nextTick();
    await r.frame();
    expect(r.sel.speech.value?.text).toBe("XY plane removed, 1 selected");
    r.selection.faces = [3, 4];
    await r.settled();
    expect(r.sel.readout.value).toBe("2 faces");
    expect(r.sel.speech.value?.text).toBe("2 faces, 1 plane selected");
  });

  it("wakes the readout with no pointer or key, and a plane cleared says so", async () => {
    const r = setup();
    await r.build();
    await r.frame();
    pickRows(["o:XY"]);
    await nextTick();
    expect(frames).toHaveLength(1);
    await r.frame();
    pickRows([]);
    await nextTick();
    await r.frame();
    expect(r.sel.readout.value).toBe("");
    expect(r.sel.speech.value).toEqual({ text: "Nothing selected", verbose: true });
  });
});

describe("the readout and the canvas keys' light", () => {
  async function listed() {
    const t = setup();
    await t.build();
    t.browser.show(true);
    await land(t.asks[0]!, topology("body1"));
    return t;
  }

  it("shows the lit row's words, follows the cursor and goes back when the light goes out", async () => {
    const t = await listed();
    t.selection.faces = [2];
    await t.settled();
    const selected = t.sel.readout.value;
    t.list.setCursor("f:body1:1");
    t.list.setLit(true);
    expect(t.sel.readout.value).toBe(describePick(t.list.rows[1]!.facts).readout);
    t.list.setCursor("f:body1:0");
    expect(t.sel.readout.value).toBe(describePick(t.list.rows[0]!.facts).readout);
    expect(t.sel.readout.value).not.toBe(selected);
    t.list.setLit(false);
    expect(t.sel.readout.value).toBe(selected);
  });

  it("does not take the readout for a row that is only the cursor", async () => {
    const t = await listed();
    t.list.setCursor("f:body1:1");
    expect(t.sel.readout.value).toBe("");
  });

  it("does not speak for the light, stepping has its own voice", async () => {
    const t = await listed();
    t.list.setCursor("f:body1:1");
    t.list.setLit(true);
    await t.settled();
    expect(t.sel.speech.value).toBeNull();
  });
});
