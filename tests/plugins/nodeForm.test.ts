import { describe, expect, it } from "vitest";
import {
  freshNodeId, halfExtent, link, nodeNumFields, nodesBox, roundSize, sizeLabel, unlinkNode,
  type NodeValues,
} from "../../plugins/FundaCAD.Organic/nodeForm";

const node = (id: string, over: Partial<NodeValues> = {}): NodeValues => ({
  id, x: 0, y: 0, z: 0, sx: 5, sy: 5, sz: 5, rx: 0, ry: 0, rz: 0, ...over,
});

describe("node body form", () => {
  it("lists every node's rows by id", () => {
    const rows = nodeNumFields({ nodes: [node("n1"), node("n7")] });
    expect(rows[0]).toEqual(["blend", "Blend", "length"]);
    expect(rows).toContainEqual(["nodes.n7.sx", "n7 Radius X", "length"]);
    expect(rows).toContainEqual(["nodes.n1.rz", "n1 Turn Z", "angle"]);
    expect(rows).toHaveLength(1 + 2 * 9);
    expect(nodeNumFields({})).toEqual([["blend", "Blend", "length"]]);
  });

  it("links onto a chain end, or starts a chain", () => {
    expect(link([], "a", "b")).toEqual([["a", "b"]]);
    expect(link([["a", "b"]], "b", "c")).toEqual([["a", "b", "c"]]);
    expect(link([["a", "b"]], "a", "c")).toEqual([["c", "a", "b"]]);
    expect(link([["a", "b", "c"]], "b", "d")).toEqual([["a", "b", "c"], ["b", "d"]]);
    expect(link([["a", "b"]], "b", "a")).toEqual([["a", "b"]]);
  });

  it("splits a chain where a node leaves it", () => {
    expect(unlinkNode([["a", "b", "c", "d", "e"]], "c")).toEqual([["a", "b"], ["d", "e"]]);
    expect(unlinkNode([["a", "b", "c"]], "b")).toEqual([]);
    expect(unlinkNode([["a", "b"], ["b", "c", "d"]], "a")).toEqual([["b", "c", "d"]]);
  });

  it("names nodes without reusing an id", () => {
    expect(freshNodeId([])).toBe("n1");
    expect(freshNodeId([{ id: "n2" }])).toBe("n3");
    expect(freshNodeId([{ id: "n1" }, { id: "n3" }])).toBe("n4");
  });

  it("frames turned nodes by their real extent", () => {
    const flat = node("a", { sx: 10, sy: 2, sz: 1 });
    expect(halfExtent(flat).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([10, 2, 1]);
    const turned = node("a", { sx: 10, sy: 2, sz: 1, rz: 90 });
    expect(halfExtent(turned).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([2, 10, 1]);
    const box = nodesBox([flat, node("b", { x: 30, sx: 3 })]);
    expect(box?.min[0]).toBeCloseTo(-10);
    expect(box?.max[0]).toBeCloseTo(33);
    expect(nodesBox([])).toBeNull();
  });

  it("offers round sizes and reads them back plainly", () => {
    expect(roundSize(3.7)).toBe(5);
    expect(roundSize(0.9)).toBe(1);
    expect(roundSize(14)).toBe(20);
    expect(sizeLabel(10)).toBe("1 cm");
    expect(sizeLabel(12.5)).toBe("12.5 mm");
    expect(sizeLabel(4)).toBe("4 mm");
  });
});
