// The imported-assembly grouping the Browser panel renders.
//
// DOM emission is not covered here (no jsdom in this project, deliberately,
// see vitest.config.ts). What IS covered is the part with real logic: walking a
// body's node chain to the root, keeping sibling identity straight, and refusing
// to lose a body when the manifest is malformed.
import { describe, expect, it } from "vitest";
import { buildAssemblyGroups, buildBodyTree, type TreeGroup } from "../../src/ui/browserTree";
import type { ElementDef } from "../../src/document/elements";

type Node = { name: string; parent: number | null };

/** The shape sidecar/step_assembly.py emits for asm_nested.step: a root with a
 *  subassembly instanced twice, each holding two products. */
const NESTED: Node[] = [
  { name: "Robot", parent: null },       // 0
  { name: "Electronics", parent: 0 },    // 1
  { name: "Board", parent: 1 },          // 2
  { name: "MCU", parent: 2 },            // 3
  { name: "Header (x2)", parent: 2 },    // 4
  { name: "Board", parent: 1 },          // 5  <- same NAME, different occurrence
  { name: "MCU", parent: 5 },            // 6
  { name: "Header (x2)", parent: 5 },    // 7
  { name: "Chassis", parent: 0 },        // 8
];

const trees = (nodes: Node[]) => new Map([["f1", nodes]]);
const body = (id: string, name: string, nodeRef?: string) =>
  nodeRef === undefined ? { id, name } : { id, name, nodeRef };

describe("buildAssemblyGroups", () => {
  it("returns null when no body belongs to an assembly", () => {
    const out = buildAssemblyGroups([body("body1", "Body1"), body("body2", "Body2")], trees(NESTED));
    expect(out).toBeNull();
  });

  it("nests bodies under their product's full ancestor chain", () => {
    const out = buildAssemblyGroups([body("body1", "MCU", "f1/3")], trees(NESTED))!;
    expect(out.roots).toHaveLength(1);
    const robot = out.roots[0]!;
    expect(robot.label).toBe("Robot");
    expect(robot.children[0]!.label).toBe("Electronics");
    expect(robot.children[0]!.children[0]!.label).toBe("Board");
    expect(out.ancestors.get("body1")).toEqual(["n:f1/0", "n:f1/1", "n:f1/2", "n:f1/3"]);
  });

  it("keeps two occurrences of the same subassembly separate", () => {
    // Both are called "Board". Keyed on the NODE INDEX, not the display name,
    // they must stay two independent groups, otherwise selecting or collapsing
    // one silently affects the other.
    const out = buildAssemblyGroups(
      [body("body1", "MCU", "f1/3"), body("body2", "MCU", "f1/6")],
      trees(NESTED),
    )!;
    const electronics = out.roots[0]!.children[0]!;
    expect(electronics.children).toHaveLength(2);
    expect(electronics.children.map((c) => c.label)).toEqual(["Board", "Board"]);
    expect(electronics.children[0]!.key).not.toBe(electronics.children[1]!.key);
  });

  it("groups every solid of a multi-solid product under one node", () => {
    const out = buildAssemblyGroups(
      [
        body("body1", "Header (x2) 1", "f1/4"),
        body("body2", "Header (x2) 2", "f1/4"),
      ],
      trees(NESTED),
    )!;
    const board = out.roots[0]!.children[0]!.children[0]!;
    expect(board.children).toHaveLength(1);
    expect(board.children[0]!.bodies.map((b) => b.name)).toEqual([
      "Header (x2) 1",
      "Header (x2) 2",
    ]);
  });

  it("counts every descendant body, not just direct children", () => {
    const out = buildAssemblyGroups(
      [
        body("body1", "MCU", "f1/3"),
        body("body2", "Header (x2) 1", "f1/4"),
        body("body3", "Header (x2) 2", "f1/4"),
        body("body4", "MCU", "f1/6"),
        body("body5", "Chassis", "f1/8"),
      ],
      trees(NESTED),
    )!;
    expect(out.roots[0]!.total).toBe(5); // Robot
    expect(out.roots[0]!.children[0]!.total).toBe(4); // Electronics
  });

  it("keeps a body whose nodeRef does not resolve, rather than dropping it", () => {
    // A body missing from the browser is invisible AND unselectable, strictly
    // worse than one shown at the top level.
    const out = buildAssemblyGroups(
      [
        body("body1", "MCU", "f1/3"),
        body("body2", "Orphan", "f1/999"), // index past the end
        body("body3", "Wrong feature", "f9/0"), // unknown import
        body("body4", "Malformed", "nonsense"), // no slash
      ],
      trees(NESTED),
    )!;
    expect(out.loose.map((b) => b.name)).toEqual(["Orphan", "Wrong feature", "Malformed"]);
  });

  it("survives a cyclic parent chain in a hand-edited document", () => {
    const cyclic: Node[] = [
      { name: "A", parent: 1 },
      { name: "B", parent: 0 },
    ];
    const out = buildAssemblyGroups([body("body1", "x", "f1/0")], trees(cyclic))!;
    // terminates, and still files the body somewhere reachable
    expect(out.loose).toHaveLength(0);
    expect(out.roots).toHaveLength(1);
  });

  it("falls back to a placeholder for an unnamed product", () => {
    const out = buildAssemblyGroups(
      [body("body1", "x", "f1/0")],
      trees([{ name: "", parent: null }]),
    )!;
    expect(out.roots[0]!.label).toBe("Part");
  });

  it("collapses a large assembly to a handful of top-level rows", () => {
    // The row-count claim behind shipping this without virtualisation: assembly
    // nodes default to collapsed, so a 3,000-body import paints its ROOTS, not
    // 3,000 rows. Modelled on the reference file: one root, 12 levels deep.
    const nodes: Node[] = [{ name: "Root", parent: null }];
    const bodies = [];
    for (let i = 0; i < 3000; i++) {
      nodes.push({ name: `Sub ${i}`, parent: 0 });
      nodes.push({ name: `Part ${i}`, parent: nodes.length - 1 });
      bodies.push(body(`body${i}`, `Part ${i}`, `f1/${nodes.length - 1}`));
    }
    const out = buildAssemblyGroups(bodies, trees(nodes))!;
    // collapsed, the panel emits one head per ROOT, not one row per body
    expect(out.roots).toHaveLength(1);
    expect(out.roots[0]!.total).toBe(3000);
    expect(out.loose).toHaveLength(0);
  });

  it("mixes assembly bodies with ordinary ones in the same document", () => {
    const out = buildAssemblyGroups(
      [body("body1", "Extrude1"), body("body2", "MCU", "f1/3")],
      trees(NESTED),
    )!;
    expect(out.loose.map((b) => b.name)).toEqual(["Extrude1"]);
    expect(out.roots).toHaveLength(1);
  });
});

// --- the merged tree: the user's elements over the imports' own --------------

describe("buildBodyTree", () => {
  const el = (id: string, name: string, parent?: string): ElementDef =>
    parent === undefined ? { id, name } : { id, name, parent };
  const assigned = (pairs: [string, string][]) => new Map(pairs);
  const labels = (g: TreeGroup): unknown =>
    [g.kind, g.label, g.total, g.bodies.map((b) => b.id), g.children.map(labels)];

  it("draws the flat list unchanged when there is neither an element nor an assembly", () => {
    const out = buildBodyTree([body("body1", "Body1"), body("body2", "Body2")], trees([]), [], new Map());
    expect(out.groups).toEqual([]);
    expect(out.loose.map((b) => b.id)).toEqual(["body1", "body2"]);
  });

  it("keeps an empty element, so a folder can be made before it is filled", () => {
    const out = buildBodyTree([body("body1", "Body1")], trees([]), [el("e1", "Rig")], new Map());
    expect(out.groups.map(labels)).toEqual([["element", "Rig", 0, [], []]]);
    expect(out.loose.map((b) => b.id)).toEqual(["body1"]);
  });

  it("nests elements and counts every body at or below one", () => {
    const out = buildBodyTree(
      [body("body1", "A"), body("body2", "B"), body("body3", "C")],
      trees([]),
      [el("e1", "Rig"), el("e2", "Motor", "e1")],
      assigned([["body1", "e1"], ["body2", "e2"]]),
    );
    expect(out.groups.map(labels)).toEqual([
      ["element", "Rig", 2, ["body1"], [["element", "Motor", 1, ["body2"], []]]],
    ]);
    expect(out.loose.map((b) => b.id)).toEqual(["body3"]);
    expect(out.ancestors.get("body2")).toEqual(["e:e1", "e:e2"]);
  });

  it("takes a filed body OUT of the assembly node it was imported under", () => {
    const bodies = [body("body1", "MCU", "f1/3"), body("body2", "MCU", "f1/6")];
    // the control first: with no element, both sit under the imported tree
    const before = buildBodyTree(bodies, trees(NESTED), [], new Map());
    expect(before.groups.map((g) => g.kind)).toEqual(["assembly"]);
    expect(before.groups[0]!.total).toBe(2);

    const after = buildBodyTree(bodies, trees(NESTED), [el("e1", "Spares")], assigned([["body1", "e1"]]));
    expect(after.groups.map((g) => [g.kind, g.total])).toEqual([
      ["element", 1],
      ["assembly", 1],
    ]);
    expect(after.ancestors.get("body1")).toEqual(["e:e1"]);
    expect(after.ancestors.get("body2")![0]).toBe("n:f1/0");
  });

  it("ignores an assignment to an element that is not there", () => {
    const out = buildBodyTree([body("body1", "A")], trees([]), [], assigned([["body1", "gone"]]));
    expect(out.groups).toEqual([]);
    expect(out.loose.map((b) => b.id)).toEqual(["body1"]);
  });

  it("puts elements before the imported structure, and loose bodies last", () => {
    const out = buildBodyTree(
      [body("body1", "Loose"), body("body2", "MCU", "f1/3"), body("body3", "Filed")],
      trees(NESTED),
      [el("e1", "Rig")],
      assigned([["body3", "e1"]]),
    );
    expect(out.groups.map((g) => g.kind)).toEqual(["element", "assembly"]);
    expect(out.loose.map((b) => b.id)).toEqual(["body1"]);
  });
});
