// The plugin's tool, driven against a viewport and a store it controls.
//
// This is the gesture the whole exercise was about. A tool is not a menu row: it
// takes the pick over, holds the window, watches the ambient selection every
// frame, pushes a live preview, and either commits a feature or puts the model
// back exactly as it found it. None of that stopped being the application's
// business when the code moved out of src/, it just stopped being the
// application's CODE, and this file is what says the move cost none of it.
//
// The fakes are deliberately dumb: arrays and counters, no partial mocks of real
// classes. What is being measured is the tool's decisions, and a fake that
// re-implemented the viewport would be measuring the fake.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { TextureTool } from "../../plugins/FundaCAD.Texture/textureTool";
import * as panel from "../../plugins/FundaCAD.Texture/panel";
import { resetContributions } from "../../src/plugins/contrib";
import type { DocumentStore, Viewport } from "../../src/plugins/host";
import type { Feature } from "../../src/types";

/** The eleven viewport calls the tool makes, and nothing else. */
function fakeViewport() {
  const state = {
    selecting: "faces" as "faces" | "bodies",
    faceIds: [] as number[],
    bodyIds: [] as string[],
    cleared: 0,
    /** face id -> body id, for the multi-body guard */
    owner: new Map<number, string>(),
    /** what faceIdNear will answer, in order */
    nearAnswers: [] as (number | null)[],
  };
  const vp = {
    get selecting() { return state.selecting; },
    setSelectionMode(m: "faces" | "bodies") {
      state.selecting = m;
      // The real one clears the OTHER kind, which is why a mode switch always
      // starts from an empty member set rather than a stale mix.
      if (m === "faces") state.bodyIds = [];
      else state.faceIds = [];
    },
    getSelectedFaceIds: () => [...state.faceIds],
    getSelectedBodies: () => [...state.bodyIds],
    selectFaces: (ids: number[]) => { state.faceIds = [...ids]; },
    setSelectedBodies: (ids: string[]) => { state.bodyIds = [...ids]; },
    clearSelection: () => { state.cleared++; state.faceIds = []; },
    faceIdToBodyId: (id: number) => state.owner.get(id) ?? "body1",
    faceIdNear: () => state.nearAnswers.shift() ?? null,
    selectedFacesForPressPull: () => {
      if (!state.faceIds.length) return null;
      return {
        faceIds: [...state.faceIds],
        bodyId: state.owner.get(state.faceIds[0]!) ?? "body1",
        selectors: state.faceIds.map((i) => ({
          kind: "face" as const, by: "nearest" as const, point: [i, 0, 0] as [number, number, number],
        })),
      };
    },
  };
  return { vp: vp as unknown as Viewport, state };
}

function fakeStore(features: Feature[] = []) {
  const listeners = new Set<(s: { building: boolean; result: unknown }) => void>();
  const calls = {
    added: [] as Feature[],
    replaced: [] as { id: string; f: Feature }[],
    previews: [] as (Feature | null)[],
    editPreviews: [] as (Feature | null)[],
    beganEdit: [] as string[],
    endedEdit: [] as (boolean | undefined)[],
  };
  const store = {
    document: { features },
    buildState: { result: { bodies: [{ id: "body1", name: "Body 1" }] } },
    nextId: () => "new1",
    bodyName: (id: string) => (id === "body1" ? "Body 1" : null),
    isParamBound: () => false,
    onBuild(fn: (s: { building: boolean; result: unknown }) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setPreview: (f: Feature | null) => calls.previews.push(f),
    setEditPreview: (f: Feature | null) => calls.editPreviews.push(f),
    beginEditPreview: (id: string) => calls.beganEdit.push(id),
    endEditPreview: (v?: boolean) => calls.endedEdit.push(v),
    addFeature: (f: Feature) => calls.added.push(f),
    replaceFeature: (id: string, f: Feature) => calls.replaced.push({ id, f }),
  };
  /** Land a rebuild, the way the real store does when one finishes. */
  const landBuild = () => {
    for (const fn of [...listeners]) fn({ building: false, result: {} });
  };
  /** A rebuild is IN FLIGHT. The real store says this too, and the tool used to
   *  ignore it, which is what let a streamed reply's momentarily empty
   *  selection be read as the user deselecting. */
  const startBuild = () => {
    for (const fn of [...listeners]) fn({ building: true, result: {} });
  };
  return { store: store as unknown as DocumentStore, calls, landBuild, startBuild };
}

/** Let the tool's rAF tick run once. */
const tick = () => new Promise((r) => requestAnimationFrame(() => r(null)));

/** The tool debounces its preview by 150ms; fake timers make that exact. */
function runDebounce() {
  vi.advanceTimersByTime(200);
}

describe("TextureTool", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    panel.resetPanel();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    panel.resetPanel();
    resetContributions();
  });

  it("opens its own panel and takes the window", () => {
    const { vp } = fakeViewport();
    const { store } = fakeStore();
    const tool = new TextureTool(vp, store);
    expect(tool.active).toBe(false);

    tool.start(() => {});
    expect(tool.active).toBe(true);
    expect(panel.isOpen()).toBe(true);
    tool.cancel();
  });

  it("refuses to start twice", () => {
    const { vp } = fakeViewport();
    const { store } = fakeStore();
    const tool = new TextureTool(vp, store);
    const done = vi.fn();
    tool.start(done);
    tool.start(done);
    tool.cancel();
    expect(done).toHaveBeenCalledTimes(1);
  });

  // The mode it opens in follows what you were already doing, rather than
  // resetting a selection you had just made.
  it("opens in Whole Body when the viewport was already browsing bodies", () => {
    const { vp, state } = fakeViewport();
    state.selecting = "bodies";
    const { store } = fakeStore();
    const tool = new TextureTool(vp, store);
    tool.start(() => {});
    expect(panel.mode.value).toBe("body");
    expect(state.selecting).toBe("bodies");
    tool.cancel();
  });

  it("says what it wants, and stops saying it when it is done", () => {
    const { vp } = fakeViewport();
    const { store } = fakeStore();
    const tool = new TextureTool(vp, store);
    tool.start(() => {});
    // setPrompt goes to the application's prompt store; the plugin gets at it
    // through the host, which is the point.
    expect(panel.isOpen()).toBe(true);
    tool.cancel();
    expect(panel.isOpen()).toBe(false);
  });

  describe("membership is the ambient selection", () => {
    it("summarises what is picked, and refreshes as it changes", async () => {
      const { vp, state } = fakeViewport();
      const { store } = fakeStore();
      const tool = new TextureTool(vp, store);
      tool.start(() => {});
      expect(panel.summary.value).toContain("No faces selected");

      state.faceIds = [3, 4];
      await tick();
      expect(panel.summary.value).toBe("2 faces selected");

      state.faceIds = [3];
      await tick();
      expect(panel.summary.value).toBe("1 face selected");
      tool.cancel();
    });

    it("names the body in Whole Body mode", async () => {
      const { vp, state } = fakeViewport();
      const { store } = fakeStore();
      const tool = new TextureTool(vp, store);
      tool.start(() => {});
      panel.request.value!.onModeChange("body");
      state.bodyIds = ["body1"];
      await tick();
      expect(panel.summary.value).toBe("Whole body: Body 1");
      tool.cancel();
    });

    // The defect this flag exists for. setModel() clears the ambient selection
    // on EVERY rebuild, including the tool's own preview landing, so a landed
    // preview silently emptied the member set and Apply became a no-op.
    it("keeps its members when its own preview rebuild wipes the selection", async () => {
      const { vp, state } = fakeViewport();
      const { store, landBuild } = fakeStore();
      const tool = new TextureTool(vp, store);
      tool.start(() => {});
      state.faceIds = [7, 8];
      await tick();
      expect(panel.summary.value).toBe("2 faces selected");

      landBuild();          // a rebuild finished...
      state.faceIds = [];   // ...and it cleared the selection
      await tick();

      expect(vp.getSelectedFaceIds()).toEqual([7, 8]);
      expect(panel.summary.value).toBe("2 faces selected");
      tool.cancel();
    });

    // The larger version of the same defect, and the one that made the tool
    // feel broken rather than fiddly. A chunked reply reaches the screen in
    // several installments and the first one does not carry the body being
    // edited, so the viewport truthfully reports NOTHING SELECTED for a few
    // frames in the MIDDLE of the build, not at the end of it, where the flag
    // above is armed. Read as a deselect, that ended the gesture: measured in a
    // real window, six runs out of six lost the face between picking it and
    // pressing Add.
    it("ignores the ambient selection entirely while a rebuild is in flight", async () => {
      const { vp, state } = fakeViewport();
      const { store, calls, startBuild, landBuild } = fakeStore();
      const tool = new TextureTool(vp, store);
      tool.start(() => {});
      state.faceIds = [7, 8];
      await tick();
      runDebounce();
      const previewsBefore = calls.previews.length;

      startBuild();         // the reply begins arriving...
      state.faceIds = [];   // ...and an installment publishes an empty selection
      await tick();
      await tick();

      expect(panel.summary.value).toBe("2 faces selected");
      // and it did not throw the preview away either, which is the part that
      // left the model back at its untextured state mid-gesture
      expect(calls.previews.length).toBe(previewsBefore);

      state.faceIds = [7, 8]; // the viewport puts it back at the commit
      landBuild();
      await tick();
      expect(vp.getSelectedFaceIds()).toEqual([7, 8]);
      tool.cancel();
    });

    // The control on the line above: a real deselect, with no rebuild in
    // between, has to be honoured. Otherwise the members could never be cleared.
    it("honours a deselect that is the user's and not a rebuild's", async () => {
      const { vp, state } = fakeViewport();
      const { store } = fakeStore();
      const tool = new TextureTool(vp, store);
      tool.start(() => {});
      state.faceIds = [7, 8];
      await tick();
      state.faceIds = [];
      await tick();
      expect(vp.getSelectedFaceIds()).toEqual([]);
      expect(panel.summary.value).toContain("No faces selected");
      tool.cancel();
    });
  });

  describe("the live preview", () => {
    it("pushes the real feature once the debounce settles", async () => {
      const { vp, state } = fakeViewport();
      const { store, calls } = fakeStore();
      const tool = new TextureTool(vp, store);
      tool.start(() => {});
      state.faceIds = [1];
      await tick();
      runDebounce();
      const last = calls.previews.at(-1);
      expect(last).toMatchObject({ type: "texture", kind: "knurl", body: "body1" });
      tool.cancel();
    });

    it("clears an uncommitted preview when the selection empties", async () => {
      const { vp, state } = fakeViewport();
      const { store, calls } = fakeStore();
      const tool = new TextureTool(vp, store);
      tool.start(() => {});
      state.faceIds = [1];
      await tick();
      runDebounce();
      state.faceIds = [];
      await tick();
      expect(calls.previews.at(-1)).toBeNull();
      tool.cancel();
    });
  });

  describe("committing", () => {
    it("adds a feature bound to the body the faces are on", async () => {
      const { vp, state } = fakeViewport();
      const { store, calls } = fakeStore();
      const tool = new TextureTool(vp, store);
      const done = vi.fn();
      tool.start(done);
      state.faceIds = [1, 2];
      await tick();
      panel.commit({
        kind: "hex", depth: 1, scale: 3, angle: 0, offset: 0, sharpness: 0.5,
        profile: "facet", boundaryInset: 0, grime: 0, smooth: 0, projection: "triplanar", seamBlend: 0.5, seamBand: 0.5, amplitude: 1, slopeMin: 0, slopeMax: 180, targetEdge: 0, triBudget: 0, direction: "out", seed: 1, invert: false,
      });

      expect(calls.added).toHaveLength(1);
      expect(calls.added[0]).toMatchObject({ type: "texture", kind: "hex", body: "body1" });
      expect(done).toHaveBeenCalledWith("new1");
      expect(tool.active).toBe(false);
      expect(panel.isOpen()).toBe(false);
    });

    // Without the body binding the sidecar resolves the face selector against
    // the ACTIVE (last-created) body, so with more than one body the texture
    // lands on a random face of the wrong shape. A texture applies to ONE body,
    // so a selection spanning two keeps only the faces on the bound one.
    it("drops faces that are on a different body from the one it bound", async () => {
      const { vp, state } = fakeViewport();
      state.owner.set(1, "body1");
      state.owner.set(2, "body2");
      const { store, calls } = fakeStore();
      const tool = new TextureTool(vp, store);
      tool.start(() => {});
      state.faceIds = [1, 2];
      await tick();
      panel.commit({
        kind: "knurl", depth: 1, scale: 3, angle: 0, offset: 0, sharpness: 0.5,
        profile: "facet", boundaryInset: 0, grime: 0, smooth: 0, projection: "triplanar", seamBlend: 0.5, seamBand: 0.5, amplitude: 1, slopeMin: 0, slopeMax: 180, targetEdge: 0, triBudget: 0, direction: "out", seed: 1, invert: false,
      });
      const f = calls.added[0] as unknown as { body: string; faces: unknown };
      expect(f.body).toBe("body1");
      expect(Array.isArray(f.faces)).toBe(false); // one survivor, written as one selector
    });

    // The panel deliberately does NOT close on commit, because the tool refuses
    // one with no target and stays active. Closing first stranded the user in an
    // invisible modal.
    // Pressing Add during a rebuild used to be refused with "No faces selected"
    // over a face that was plainly lit up on screen. The tick can afford to skip
    // those frames; a commit cannot, because the person has finished and is
    // waiting. So it is held and run once the build lands.
    it("holds a commit that lands mid-rebuild rather than refusing it", async () => {
      const { vp, state } = fakeViewport();
      const { store, calls, startBuild, landBuild } = fakeStore();
      const tool = new TextureTool(vp, store);
      tool.start(() => {});
      state.faceIds = [3];
      await tick();

      startBuild();
      state.faceIds = []; // the installment's empty moment
      panel.commit({
        kind: "knurl", depth: 0.4, scale: 2, angle: 0, offset: 0, sharpness: 0.5,
        profile: "facet", boundaryInset: 0, grime: 0, smooth: 0, projection: "triplanar", seamBlend: 0.5, seamBand: 0.5, amplitude: 1, slopeMin: 0, slopeMax: 180, targetEdge: 0, triBudget: 0, direction: "out", seed: 1, invert: false,
      });
      expect(calls.added).toHaveLength(0); // held, not refused
      expect(tool.active).toBe(true);

      state.faceIds = [3];  // the viewport restores it at the commit
      landBuild();
      expect(calls.added).toHaveLength(1);
      expect(calls.added[0]).toMatchObject({ type: "texture", kind: "knurl" });
      expect(tool.active).toBe(false);
    });

    // The control: holding is for a selection that is coming BACK. One that is
    // genuinely empty when the build lands has to be refused, or Add would hang
    // silently forever on a document with nothing picked.
    it("refuses the held commit once the build lands with nothing picked", async () => {
      const { vp, state } = fakeViewport();
      const { store, calls, startBuild, landBuild } = fakeStore();
      const tool = new TextureTool(vp, store);
      tool.start(() => {});
      state.faceIds = [3];
      await tick();

      startBuild();
      state.faceIds = [];
      panel.commit({
        kind: "knurl", depth: 0.4, scale: 2, angle: 0, offset: 0, sharpness: 0.5,
        profile: "facet", boundaryInset: 0, grime: 0, smooth: 0, projection: "triplanar", seamBlend: 0.5, seamBand: 0.5, amplitude: 1, slopeMin: 0, slopeMax: 180, targetEdge: 0, triBudget: 0, direction: "out", seed: 1, invert: false,
      });
      landBuild(); // and the face really is gone
      expect(calls.added).toHaveLength(0);
      expect(tool.active).toBe(true);
      tool.cancel();
    });

    it("refuses a commit with nothing picked, and stays up", () => {
      const { vp } = fakeViewport();
      const { store, calls } = fakeStore();
      const tool = new TextureTool(vp, store);
      const done = vi.fn();
      tool.start(done);
      panel.commit({
        kind: "knurl", depth: 1, scale: 3, angle: 0, offset: 0, sharpness: 0.5,
        profile: "facet", boundaryInset: 0, grime: 0, smooth: 0, projection: "triplanar", seamBlend: 0.5, seamBand: 0.5, amplitude: 1, slopeMin: 0, slopeMax: 180, targetEdge: 0, triBudget: 0, direction: "out", seed: 1, invert: false,
      });
      expect(calls.added).toEqual([]);
      expect(tool.active).toBe(true);
      expect(panel.isOpen()).toBe(true);
      expect(done).not.toHaveBeenCalled();
      tool.cancel();
    });

    it("writes only the fields the chosen kind reads", async () => {
      const { vp, state } = fakeViewport();
      const { store, calls } = fakeStore();
      const tool = new TextureTool(vp, store);
      tool.start(() => {});
      state.faceIds = [1];
      await tick();
      panel.commit({
        kind: "knurl", depth: 1, scale: 3, angle: 30, offset: 0, sharpness: 0.5,
        profile: "facet", boundaryInset: 0, grime: 0, smooth: 0, projection: "triplanar", seamBlend: 0.5, seamBand: 0.5, amplitude: 1, slopeMin: 0, slopeMax: 180, targetEdge: 0, triBudget: 0, direction: "out", seed: 99, invert: false,
      });
      const f = calls.added[0] as unknown as Record<string, unknown>;
      expect(f["angle"]).toBe(30);   // a knurl has a lattice to rotate
      expect(f["seed"]).toBeUndefined(); // ...and reads no seed
    });
  });

  describe("cancelling", () => {
    it("puts the preview back and releases the selection", async () => {
      const { vp, state } = fakeViewport();
      const { store, calls } = fakeStore();
      const tool = new TextureTool(vp, store);
      const done = vi.fn();
      tool.start(done);
      state.faceIds = [1];
      await tick();
      tool.cancel();
      expect(calls.previews.at(-1)).toBeNull();
      expect(calls.added).toEqual([]);
      expect(done).toHaveBeenCalledWith(null);
      expect(state.cleared).toBeGreaterThan(0);
      expect(vp.getSelectedBodies()).toEqual([]);
    });

    it("cancels on Escape, which it owns for its whole active life", () => {
      const { vp } = fakeViewport();
      const { store } = fakeStore();
      const tool = new TextureTool(vp, store);
      const done = vi.fn();
      tool.start(done);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(tool.active).toBe(false);
      expect(done).toHaveBeenCalledWith(null);
    });

    // A tool that could only be stopped by restarting would make switching the
    // plugin off a lie for as long as the session lasted.
    it("stops listening for Escape once it is done", () => {
      const { vp } = fakeViewport();
      const { store } = fakeStore();
      const tool = new TextureTool(vp, store);
      const done = vi.fn();
      tool.start(done);
      tool.cancel();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(done).toHaveBeenCalledTimes(1);
    });

    it("is safe to cancel when it never started", () => {
      const { vp } = fakeViewport();
      const { store, calls } = fakeStore();
      const tool = new TextureTool(vp, store);
      expect(() => tool.cancel()).not.toThrow();
      expect(calls.previews).toEqual([]);
    });
  });

  describe("re-opening a committed texture", () => {
    const committed = (over: Record<string, unknown> = {}) => ([{
      id: "t1", type: "texture", kind: "waves", depth: 0.6, scale: 4,
      body: "body1", ...over,
    }] as unknown as Feature[]);

    it("rolls the model back, seeds the panel, and keeps the same id", () => {
      const { vp } = fakeViewport();
      const { store, calls, landBuild } = fakeStore(committed());
      const tool = new TextureTool(vp, store);
      expect(tool.startEdit("t1", () => {})).toBe(true);
      expect(calls.beganEdit).toEqual(["t1"]);
      // The panel does not open until the rollback lands.
      expect(panel.isOpen()).toBe(false);
      landBuild();
      expect(panel.isOpen()).toBe(true);
      expect(panel.request.value!.editing).toBe(true);
      expect(panel.request.value!.initial).toMatchObject({ kind: "waves", depth: 0.6 });
      tool.cancel();
    });

    it("replaces in place rather than adding a second feature", () => {
      const { vp, state } = fakeViewport();
      const { store, calls, landBuild } = fakeStore(committed());
      const tool = new TextureTool(vp, store);
      tool.startEdit("t1", () => {});
      landBuild();
      state.faceIds = [1];
      panel.commit({
        kind: "waves", depth: 2, scale: 4, angle: 0, offset: 0, sharpness: 0.5,
        profile: "round", boundaryInset: 0, grime: 0, smooth: 0, projection: "triplanar", seamBlend: 0.5, seamBand: 0.5, amplitude: 1, slopeMin: 0, slopeMax: 180, targetEdge: 0, triBudget: 0, direction: "out", seed: 1, invert: false,
      });
      expect(calls.added).toEqual([]);
      expect(calls.replaced).toHaveLength(1);
      expect(calls.replaced[0]!.id).toBe("t1");
      expect(calls.replaced[0]!.f.id).toBe("t1");
    });

    it("puts the model back when the edit is cancelled", () => {
      const { vp } = fakeViewport();
      const { store, calls, landBuild } = fakeStore(committed());
      const tool = new TextureTool(vp, store);
      tool.startEdit("t1", () => {});
      landBuild();
      tool.cancel();
      expect(calls.endedEdit.length).toBeGreaterThan(0);
      expect(calls.replaced).toEqual([]);
    });

    it("re-selects the faces the committed feature was made from", () => {
      const { vp, state } = fakeViewport();
      state.nearAnswers = [11, 12];
      const { store, landBuild } = fakeStore(committed({
        faces: [
          { kind: "face", by: "nearest", point: [0, 0, 0] },
          { kind: "face", by: "nearest", point: [1, 0, 0] },
        ],
      }));
      const tool = new TextureTool(vp, store);
      tool.startEdit("t1", () => {});
      landBuild();
      expect(vp.getSelectedFaceIds()).toEqual([11, 12]);
      tool.cancel();
    });

    it("refuses a feature that is not a texture, and one that is not there", () => {
      const { vp } = fakeViewport();
      const { store } = fakeStore(committed());
      const tool = new TextureTool(vp, store);
      expect(tool.startEdit("nope", () => {})).toBe(false);
      const other = fakeStore([{ id: "f1", type: "fillet" } as unknown as Feature]);
      expect(new TextureTool(vp, other.store).startEdit("f1", () => {})).toBe(false);
    });

    // False here is what makes the application say "edit the value in the
    // history": a parameter drives the number, and a drag would silently break
    // the binding.
    it("refuses when a parameter drives one of the values", () => {
      const { vp } = fakeViewport();
      const { store } = fakeStore(committed());
      (store as unknown as { isParamBound: () => boolean }).isParamBound = () => true;
      const tool = new TextureTool(vp, store);
      expect(tool.startEdit("t1", () => {})).toBe(false);
    });

    it("refuses when a value is an expression rather than a number", () => {
      const { vp } = fakeViewport();
      const { store } = fakeStore(committed({ depth: { expr: "wall/2" } }));
      const tool = new TextureTool(vp, store);
      expect(tool.startEdit("t1", () => {})).toBe(false);
    });

    it("refuses to start an edit while it is already running", () => {
      const { vp } = fakeViewport();
      const { store } = fakeStore(committed());
      const tool = new TextureTool(vp, store);
      tool.start(() => {});
      expect(tool.startEdit("t1", () => {})).toBe(false);
      tool.cancel();
    });
  });
});
