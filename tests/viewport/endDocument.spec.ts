// The view kept a selection memo, an edge batch holding the old model, a hover, a sketch face marker and the
// stale ghost of the document it showed, and the next document inherited them.
import { describe, expect, it } from "vitest";
import { Viewport } from "../../src/viewport/viewport";

function view() {
  const calls: string[] = [];
  const vp = Object.create(Viewport.prototype) as Viewport;
  Object.assign(vp, {
    stale: false,
    outOfDate: false,
    sketchFace: null,
    highlighter: { clearHover: () => calls.push("clearHover") },
    clearModel: () => calls.push("clearModel"),
    showSketchFace: (id: number | null) => calls.push(`sketchFace:${id}`),
    applyBodyFinish: () => calls.push("finish"),
    requestRender: () => {},
  });
  const hold = () =>
    Object.assign(vp, {
      streamMemo: { faces: [1] },
      edgeBatchesOf: { bodies: [] },
      lastHover: { clientX: 1, clientY: 2, force: false },
      userMovedCamera: true,
      stale: true,
      outOfDate: true,
    });
  const state = () => {
    const v = vp as unknown as Record<string, unknown>;
    return {
      streamMemo: v.streamMemo,
      edgeBatchesOf: v.edgeBatchesOf,
      lastHover: v.lastHover,
      userMovedCamera: v.userMovedCamera,
      stale: v.stale,
      outOfDate: v.outOfDate,
    };
  };
  return { vp, calls, hold, state };
}

const released = {
  streamMemo: null,
  edgeBatchesOf: null,
  lastHover: null,
  userMovedCamera: false,
  stale: false,
  outOfDate: false,
};

describe("ending a document in the view", () => {
  it("clears the model first and lets go of everything else the document left", () => {
    const v = view();
    v.hold();
    v.vp.endDocument();
    expect({ state: v.state(), calls: v.calls }).toEqual({
      state: released,
      calls: ["clearModel", "sketchFace:null", "finish", "finish"],
    });
  });

  it("does the same for a second document, and a view that held nothing only clears its model", () => {
    const v = view();
    v.hold();
    v.vp.endDocument();
    v.calls.length = 0;
    v.vp.endDocument();
    expect({ state: v.state(), calls: v.calls }).toEqual({ state: released, calls: ["clearModel", "sketchFace:null"] });
    v.hold();
    v.calls.length = 0;
    v.vp.endDocument();
    expect({ state: v.state(), calls: v.calls }).toEqual({
      state: released,
      calls: ["clearModel", "sketchFace:null", "finish", "finish"],
    });
  });
});

describe("a model marked out of date", () => {
  it("is ghosted and refuses picks while marked, and picks again once its build lands", () => {
    const v = view();
    const picks = () => (v.vp as unknown as { pickSuppressed: boolean }).pickSuppressed;
    v.vp.setModelOutOfDate(true);
    const marked = { picks: picks(), calls: [...v.calls] };
    v.calls.length = 0;
    v.vp.setModelOutOfDate(true);
    const again = [...v.calls];
    v.vp.setModelOutOfDate(false);
    expect({ marked, again, cleared: { picks: picks(), calls: v.calls } }).toEqual({
      marked: { picks: true, calls: ["clearHover", "finish"] },
      again: [],
      cleared: { picks: false, calls: ["finish"] },
    });
  });
});
