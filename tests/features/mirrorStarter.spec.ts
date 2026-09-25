// Mirror writes the bodies it acts on into the feature, never leaving it to
// whichever body happens to be active when the timeline builds.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

vi.mock("../../src/ui/choice", async (orig) => ({
  ...(await orig<typeof import("../../src/ui/choice")>()),
  choose: vi.fn(async () => "YZ"),
}));

import { createFeatureStarters, type FeatureStartersDeps } from "../../src/features/featureStarters";
import { resetTreePicks, routeTreeClick } from "../../src/ui/treePick";
import { createActions } from "../../src/app/actions";
import type { Engine } from "../../src/app/engine";

let frames: (() => void)[] = [];
const flushFrame = () => {
  const run = frames;
  frames = [];
  for (const f of run) f();
};

function rig(bodies: { id: string; name: string }[], selected: string[] = []) {
  let planePick = false;
  const canvas = document.createElement("canvas");
  const addFeature = vi.fn();
  const deps = {
    store: {
      document: { parameters: {}, features: [] },
      buildState: { result: { bodies, mesh: { positions: bodies.length ? [0] : [] } } },
      nextId: () => "f9",
      addFeature,
    },
    viewport: {
      domElement: canvas,
      suspendPicking: false,
      clearHover: () => {},
      hoverBody: () => {},
      getSelectedBodies: () => selected,
    },
    overlay: { regions: [], selectedRegions: () => [] },
    canvas,
    toolBusy: () => planePick,
    hasBody: () => bodies.length > 0,
    setStatus: vi.fn(),
    setPlanePick: (v: boolean) => { planePick = v; },
  } as unknown as FeatureStartersDeps;
  return { starters: createFeatureStarters(deps), addFeature };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  setActivePinia(createPinia());
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => { frames.push(f); return frames.length; });
});
afterEach(() => {
  resetTreePicks();
  vi.unstubAllGlobals();
});

describe("Mirror names its targets", () => {
  const two = [{ id: "body1", name: "Rail" }, { id: "body2", name: "Brace" }];

  it("mirrors the selected body, not the active one", async () => {
    const r = rig(two, ["body1"]);
    r.starters.startMirror();
    await settle();
    expect(r.addFeature.mock.calls[0]![0]).toEqual({ id: "f9", type: "mirror", plane: "YZ", bodies: ["body1"] });
  });

  it("asks which body when several exist and none is selected", async () => {
    const r = rig(two);
    r.starters.startMirror();
    expect(r.addFeature).not.toHaveBeenCalled();
    expect(routeTreeClick({ kind: "body", id: "body1" }, { busyHint: () => null, hint: () => {} })).toBe("taken");
    flushFrame();
    await settle();
    expect(r.addFeature.mock.calls[0]![0]).toMatchObject({ type: "mirror", bodies: ["body1"] });
  });

  it("takes the only body without asking", async () => {
    const r = rig([{ id: "body1", name: "Rail" }]);
    r.starters.startMirror();
    await settle();
    expect(r.addFeature.mock.calls[0]![0]).toMatchObject({ type: "mirror", bodies: ["body1"] });
  });
});

describe("body commands with a body selected", () => {
  // Picking a body raises the Move gizmo, which reads as busy, so the ribbon's
  // Mirror and Pattern did nothing at all for a selected body.
  it.each(["mirror", "pattern-linear", "boolean-union"])("%s stands the selection's gizmo down first", (action) => {
    const order: string[] = [];
    const act = createActions({
      sketch: { active: false },
      starters: {
        startMirror: () => order.push("start"),
        startPattern: () => order.push("start"),
        startBoolean: () => order.push("start"),
      },
      tools: { section: { picking: false, active: false } },
      dropBodyGizmo: () => order.push("drop"),
      toolBusy: () => false,
      setStatus: vi.fn(),
      lastAction: null,
    } as unknown as Engine);
    act(action);
    expect(order).toEqual(["drop", "start"]);
  });
});
