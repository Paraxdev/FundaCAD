// The pick paths stay cheap on a big body: an edge's neighbour faces come from a per body index built once, and a
// hover move with thousands of selected edges rebuilds only the hover line.
import { describe, expect, it, vi } from "vitest";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { Highlighter } from "../../src/viewport/highlight";
import { costRig } from "./pickCostRig";

describe("pick cost on a big body", () => {
  it("indexes a body's vertices once, then finds an edge's faces without walking its triangles", async () => {
    const { view, draw, mesh } = costRig(4001, 25);
    const index = mesh.geometry.getIndex()!;
    const getX = vi.spyOn(index, "getX");
    const h = new Highlighter(view);
    h.hoverEdge(draw.refs[10]!);
    await Promise.resolve();
    const first = getX.mock.calls.length;
    expect(first).toBeLessThanOrEqual(index.count + 100);
    getX.mockClear();
    h.hoverEdge(draw.refs[3000]!);
    await Promise.resolve();
    expect(getX.mock.calls.length).toBeLessThan(100);
    h.dispose();
  });

  it("a hover move over 2000 selected edges rebuilds only the hover line", async () => {
    const { view, draw } = costRig(2101, 2);
    const h = new Highlighter(view);
    for (let i = 0; i < 2000; i++) h.selectEdge(draw.refs[i]!);
    await Promise.resolve();
    const set = vi.spyOn(LineSegmentsGeometry.prototype, "setPositions");
    h.hoverEdge(draw.refs[2050]!);
    await Promise.resolve();
    h.hoverEdge(draw.refs[2060]!);
    await Promise.resolve();
    const sizes = set.mock.calls.map((c) => (c[0] as ArrayLike<number>).length);
    expect(sizes.every((n) => n === 6)).toBe(true);
    set.mockRestore();
    h.dispose();
  });

  it("a face select beside selected edges recolours them in place", async () => {
    const { view, draw } = costRig(2101, 2);
    const h = new Highlighter(view);
    for (let i = 0; i < 2000; i++) h.selectEdge(draw.refs[i]!);
    await Promise.resolve();
    const set = vi.spyOn(LineSegmentsGeometry.prototype, "setPositions");
    h.selectFace(5);
    await Promise.resolve();
    expect(set).not.toHaveBeenCalled();
    set.mockRestore();
    h.dispose();
  });
});
