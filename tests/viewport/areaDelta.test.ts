// A box preview frame repaints only what its take changed, so a drag over tens of thousands of faces and edges keeps
// up with the cursor.
import { describe, expect, it, vi } from "vitest";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { Highlighter } from "../../src/viewport/highlight";
import { FrameCoalescer } from "../../src/viewport/areaSelect";
import type { EdgeRef } from "../../src/viewport/edgeLines";
import { costRig } from "./pickCostRig";

const take = (faces: Iterable<number>, edges: Iterable<EdgeRef>, bodies: Iterable<string> = []) => ({
  faces: new Set(faces),
  edges: new Set(edges),
  bodies: new Set(bodies),
});

function spies(h: Highlighter) {
  const at = h as unknown as Record<string, (...a: unknown[]) => unknown>;
  return {
    paintFace: vi.spyOn(at, "paintFace"),
    restoreFace: vi.spyOn(at, "restoreFace"),
    tint: vi.spyOn(at, "tint"),
    overlay: vi.spyOn(at, "syncOverlay"),
  };
}

describe("box preview delta", () => {
  it("paints one face and two edges for a frame that adds one face and two edges", async () => {
    const { view, draw } = costRig(5001, 2);
    const h = new Highlighter(view);
    const faces = [...Array(5000).keys()];
    h.setSelection(take(faces, draw.refs.slice(0, 4998)));
    await Promise.resolve();
    const s = spies(h);
    const lines = vi.spyOn(LineSegmentsGeometry.prototype, "setPositions");
    expect(h.setSelection(take([...faces, 5000], draw.refs.slice(0, 5000)))).toBe(true);
    await Promise.resolve();
    expect(s.paintFace).toHaveBeenCalledTimes(1);
    expect(s.restoreFace).not.toHaveBeenCalled();
    expect(s.tint.mock.calls.length).toBeLessThanOrEqual(4);
    expect(s.overlay.mock.calls.filter((c) => c[0] === "hover").length).toBeLessThanOrEqual(1);
    expect(s.overlay.mock.calls.filter((c) => c[0] === "select").length).toBeLessThanOrEqual(1);
    expect(lines.mock.calls.length).toBeLessThanOrEqual(1);
    expect(h.getSelectedFaces().length).toBe(5001);
    expect(h.getSelectedEdges().length).toBe(5000);
    lines.mockRestore();
    h.dispose();
  });

  it("drops only what left the box", async () => {
    const { view, draw } = costRig(101, 2);
    const h = new Highlighter(view);
    h.setSelection(take([1, 2, 3], draw.refs.slice(0, 3)));
    await Promise.resolve();
    const s = spies(h);
    h.setSelection(take([1, 2], draw.refs.slice(0, 2)));
    expect(s.restoreFace).toHaveBeenCalledTimes(1);
    expect(s.paintFace).not.toHaveBeenCalled();
    expect(h.getSelectedFaces().sort()).toEqual([1, 2]);
    expect(h.getSelectedEdges()).toEqual(draw.refs.slice(0, 2));
    h.dispose();
  });

  it("repaints nothing when the take did not change, as on a release over the last preview", async () => {
    const { view, draw } = costRig(101, 2);
    const h = new Highlighter(view);
    h.setSelection(take([1, 2], draw.refs.slice(0, 5)));
    await Promise.resolve();
    const s = spies(h);
    expect(h.setSelection(take([2, 1], draw.refs.slice(0, 5)))).toBe(false);
    expect(s.paintFace).not.toHaveBeenCalled();
    expect(s.tint).not.toHaveBeenCalled();
    expect(s.overlay).not.toHaveBeenCalled();
    h.dispose();
  });

  it("stays linear on a shift box: 5000 faces over 5000 selected edges", async () => {
    const { view, draw } = costRig(5001, 2);
    const h = new Highlighter(view);
    const base = draw.refs.slice(0, 5000);
    h.setSelection(take([], base));
    await Promise.resolve();
    const s = spies(h);
    h.setSelection(take([...Array(5000).keys()], base));
    expect(s.tint.mock.calls.length).toBeLessThanOrEqual(15_000);
    expect(s.overlay.mock.calls.filter((c) => c[0] === "hover").length).toBeLessThanOrEqual(1);
    h.dispose();
  });

  it("selects and drops bodies by the delta", () => {
    const { view } = costRig(11, 2);
    const h = new Highlighter(view);
    h.setSelection(take([], [], ["b1"]));
    expect(h.getSelectedBodies()).toEqual(["b1"]);
    expect(h.setSelection(take([], [], ["b1"]))).toBe(false);
    h.setSelection(take([3], []));
    expect(h.getSelectedBodies()).toEqual([]);
    expect(h.getSelectedFaces()).toEqual([3]);
    h.dispose();
  });
});

describe("box preview coalescing", () => {
  it("runs once a frame however many moves arrive in it", () => {
    let pending: (() => void) | null = null;
    const frame = vi.fn((fn: () => void) => {
      pending = fn;
      return 1;
    });
    const run = vi.fn();
    const c = new FrameCoalescer(run, frame, () => (pending = null));
    for (let i = 0; i < 10; i++) c.queue();
    expect(frame).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    (pending as (() => void) | null)?.();
    expect(run).toHaveBeenCalledTimes(1);
    c.queue();
    expect(frame).toHaveBeenCalledTimes(2);
  });

  it("drops a pending frame on cancel, so a release paints alone", () => {
    let pending: (() => void) | null = null;
    const run = vi.fn();
    const c = new FrameCoalescer(
      run,
      (fn) => {
        pending = fn;
        return 7;
      },
      () => (pending = null),
    );
    c.queue();
    c.cancel();
    expect(pending).toBeNull();
    expect(run).not.toHaveBeenCalled();
    c.queue();
    expect(pending).not.toBeNull();
  });
});
