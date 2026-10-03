// A model that goes takes its selection with it, and says so: the drag handle and
// the prompt are placed by whoever listens, and stayed on an empty view otherwise.

import { describe, expect, it } from "vitest";
import { Viewport } from "../../src/viewport/viewport";

function streaming(sel: { faces?: number[]; edges?: unknown[]; bodies?: string[] }) {
  const heard: string[] = [];
  let disposed = 0;
  const vp = Object.create(Viewport.prototype) as Viewport;
  Object.assign(vp, {
    streaming: true,
    progressive: { filled: 0, total: 1, abort: () => {} },
    picker: { invalidate: () => {} },
    model: {},
    highlighter: {
      getSelectedFaces: () => sel.faces ?? [],
      getSelectedEdges: () => sel.edges ?? [],
      getSelectedBodies: () => sel.bodies ?? [],
      dispose: () => { disposed++; },
    },
    requestRender: () => {},
  });
  vp.onSelectionChange = () => {
    heard.push(`pick:${vp.getSelectedFaceIds().length + vp.selectedEdgeLines().length}`);
  };
  vp.onBodySelectionChange = (cause) => { heard.push(`bodies:${vp.getSelectedBodies().length}:${cause}`); };
  return { vp, heard, disposed: () => disposed };
}

describe("a model dropped with a selection on it", () => {
  it("announces the lost face once the selection reads empty", () => {
    const s = streaming({ faces: [4] });
    s.vp.abortProgressiveModel();
    expect(s.heard).toEqual(["pick:0"]);
    expect(s.disposed()).toBe(1);
  });

  it("announces a lost edge the same way", () => {
    const s = streaming({ edges: [{}] });
    s.vp.abortProgressiveModel();
    expect(s.heard).toEqual(["pick:0"]);
  });

  it("announces lost bodies as a restore, which raises no gizmo", () => {
    const s = streaming({ bodies: ["b1"] });
    s.vp.abortProgressiveModel();
    expect(s.heard).toEqual(["bodies:0:restore"]);
  });

  it("says nothing when nothing was selected", () => {
    const s = streaming({});
    s.vp.abortProgressiveModel();
    expect(s.heard).toEqual([]);
    expect(s.disposed()).toBe(1);
  });
});
