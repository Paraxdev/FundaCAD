// NV-9: committing a re-edited fillet wrote the tool's own rebuilt feature over
// the saved one, which has no name and re-derives its edges, so the feature was
// renamed to plain "Fillet". The commit now starts from the saved feature and
// takes only what changed while the tool was open.
import { describe, it, expect } from "vitest";
import { blendEditCommit, editedBlend, sameMembers } from "../../src/features/blendEdit";
import type { Feature } from "../../src/types";

const A = { kind: "edge", by: "nearest", point: [0, -46, 20.3], body: "body1" };
const B = { kind: "edge", by: "nearest", point: [0, 46, 20.3], body: "body1" };

const saved = (): Feature => ({
  id: "wall_blend",
  type: "fillet",
  name: "Bowl to wall blend",
  radius: 4,
  edges: [A, B],
  sizeType: "radius",
  tangentEdges: true,
  activeWhen: "detail > 1",
} as unknown as Feature);

// What EdgeFeatureTool.buildFeature() makes of it: no name, no activeWhen, the
// selectors in its own order.
const toolView = (radius: number, over: Record<string, unknown> = {}): Feature => ({
  id: "wall_blend",
  type: "fillet",
  edges: [B, A],
  radius,
  sizeType: "radius",
  tangentEdges: true,
  ...over,
} as unknown as Feature);

describe("blendEditCommit, a plain radius", () => {
  it("round-trips the feature except the edited radius", () => {
    const original = saved();
    const { feature, param } = blendEditCommit({
      original, opened: toolView(4), built: toolView(6), paramRef: null,
    });
    expect(param).toBeNull();
    expect(feature).toEqual({ ...original, radius: 6 });
    expect(feature).not.toBe(original);
    expect(original).toEqual(saved());
  });

  it("writes nothing when nothing changed", () => {
    expect(blendEditCommit({ original: saved(), opened: toolView(4), built: toolView(4), paramRef: null }))
      .toEqual({ feature: null, param: null });
  });

  it("keeps the saved edges, in their saved form, while the members are the same", () => {
    const one = { ...saved(), edges: A } as unknown as Feature;
    const out = editedBlend(one, toolView(4, { edges: A }), toolView(5, { edges: [A] }));
    expect((out as { edges: unknown }).edges).toBe(A);
  });

  it("takes the tool's edges when the member set changed", () => {
    const C = { kind: "edge", by: "nearest", point: [1, 2, 3] };
    const out = editedBlend(saved(), toolView(4), toolView(4, { edges: [A, B, C] }));
    expect((out as { edges: unknown }).edges).toEqual([A, B, C]);
    expect((out as { name?: string }).name).toBe("Bowl to wall blend");
  });

  it("a flip to chamfer keeps the name and drops the fillet-only fields", () => {
    const opened = toolView(4);
    const built = { id: "wall_blend", type: "chamfer", edges: [B, A], distance: 2 } as unknown as Feature;
    const out = editedBlend(saved(), opened, built) as unknown as Record<string, unknown>;
    expect(out).toEqual({
      id: "wall_blend", type: "chamfer", name: "Bowl to wall blend", edges: [A, B], distance: 2,
      activeWhen: "detail > 1",
    });
  });
});

describe("blendEditCommit, a radius bound to a bare parameter", () => {
  it("sets the parameter and leaves the feature alone", () => {
    const { feature, param } = blendEditCommit({
      original: saved(), opened: toolView(4), built: toolView(12), paramRef: "wall_blend_r",
    });
    expect(feature).toBeNull();
    expect(param).toEqual({ name: "wall_blend_r", value: 12 });
  });

  it("with another change too, patches that change and keeps the bound radius", () => {
    const { feature, param } = blendEditCommit({
      original: saved(), opened: toolView(4), built: toolView(5, { continuity: "G2" }), paramRef: "wall_blend_r",
    });
    expect(feature).toEqual({ ...saved(), continuity: "G2" });
    expect(param).toEqual({ name: "wall_blend_r", value: 5 });
  });

  it("does not touch the parameter when only something else moved", () => {
    const { param } = blendEditCommit({
      original: saved(), opened: toolView(4), built: toolView(4, { profile: 0.3 }), paramRef: "wall_blend_r",
    });
    expect(param).toBeNull();
  });
});

describe("sameMembers", () => {
  it("ignores order and a lone selector against a list of one", () => {
    expect(sameMembers([A, B], [B, A])).toBe(true);
    expect(sameMembers(A, [A])).toBe(true);
    expect(sameMembers([A], [A, B])).toBe(false);
  });
});
