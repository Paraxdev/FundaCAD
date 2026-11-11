// The offset tool commits a chain with a spline edge, and says so when the spline cannot follow the distance.
import { describe, it, expect, vi } from "vitest";

const toasts = vi.hoisted(() => [] as string[]);
vi.mock("../../src/ui/toast", () => ({ toast: (m: string) => void toasts.push(m) }));
vi.mock("../../src/ui/prompt", () => ({ setPrompt() {} }));

import { ModifyFlow, type ModifyHost } from "../../src/sketch/modifyFlow";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";

const a = 0.37;
const xf = (x: number, y: number): [number, number] => [
  61.3 + x * Math.cos(a) - y * Math.sin(a),
  -27.9 + x * Math.sin(a) + y * Math.cos(a),
];
const L = (id: string, p: [number, number], q: [number, number]): ResolvedEntity => {
  const [x1, y1] = xf(...p),
    [x2, y2] = xf(...q);
  return { type: "line", id, x1, y1, x2, y2 };
};
const bump = (): ResolvedEntity[] => [
  L("l1", [0, 0], [30, 0]),
  {
    type: "spline",
    id: "s",
    points: Array.from({ length: 9 }, (_, k) => {
      const t = -Math.PI / 2 + (k / 8) * Math.PI;
      const [x, y] = xf(30 + 4 * Math.cos(t), 4 + 4 * Math.sin(t));
      return { x, y };
    }),
  },
  L("l2", [30, 8], [0, 60]),
  L("l3", [0, 60], [0, 0]),
];

function commit(ents: ResolvedEntity[], mag: number, side = 1) {
  toasts.length = 0;
  const state = { ents, driving: [] as SketchConstraint[], modified: 0 };
  const host = {
    entities: () => state.ents,
    setEntities: (l: ResolvedEntity[]) => void (state.ents = l),
    dim: () => ({ isUserDriven: () => false, hide() {} }),
    overlay: () => ({ setPreview() {} }),
    planeEdges: () => [],
    emphasiseModelEdges() {},
    setDrivingDimension: (c: SketchConstraint) => void state.driving.push(c),
    afterModify: () => void state.modified++,
  } as unknown as ModifyHost;
  const flow = new ModifyFlow(host);
  Object.assign(flow, { offsetPick: { idx: 0, side, mag, added: [] } });
  (flow as unknown as { commitOffset(): void }).commitOffset();
  return { flow, ...state, toasts: [...toasts] };
}

describe("committing an offset around a spline edge", () => {
  it("adds the closed copy and one driving dimension when the spline can follow", () => {
    const before = bump();
    const r = commit(before, 3.9);
    expect(r.ents.slice(0, 4)).toEqual(before);
    expect(r.ents.slice(4).map((e) => e.type)).toEqual(["line", "spline", "line", "line"]);
    expect(r.driving.map((c) => (c.type === "offset" ? [c.pairs.length, c.value] : null))).toEqual([[3, 3.9]]);
    expect(r.toasts).toEqual([]);
    expect(r.modified).toBe(1);
  });

  it("toasts and changes nothing when the spline cannot follow, offset and picks cleared", () => {
    const before = bump();
    const r = commit(before, 5);
    expect(r.ents).toBe(before);
    expect(r.driving).toEqual([]);
    expect(r.toasts).toHaveLength(1);
    expect(r.toasts[0]).toMatch(/spline/i);
    expect(r.flow.offsetting).toBe(false);
    expect(r.modified).toBe(0);
  });

  it("still says collapse, not spline, for a circle shrunk away", () => {
    const r = commit([{ type: "circle", id: "c", x: 7.5, y: -3.25, radius: 2 }], 5, -1);
    expect(r.toasts).toHaveLength(1);
    expect(r.toasts[0]).not.toMatch(/spline/i);
  });
});
