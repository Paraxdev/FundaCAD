// Where a circular pattern turns: the origin, the part's middle, or a line
// picked on the model, and the fields each is committed as.
import { describe, expect, it } from "vitest";
import {
  axisLine,
  canonicalDir,
  circularAxisFields,
  defaultAxisPlace,
  describeAxis,
} from "../../src/features/patternAxis";
import { patternAxisChoice, patternAxisPatch, PLACED_AXIS } from "../../src/document/optionFields";
import type { Feature, Selector } from "../../src/types";

const ref: Selector = { kind: "face", by: "nearest", point: [35, 30, 5], body: "body1" } as Selector;

describe("patternAxis", () => {
  it("starts on the part for a feature and on the origin for whole bodies", () => {
    expect(defaultAxisPlace(true)).toBe("centre");
    expect(defaultAxisPlace(false)).toBe("origin");
  });

  it("points a found direction the way the engine does, largest component positive", () => {
    expect(canonicalDir([0, 0, -2])).toEqual([0, 0, 1]);
    expect(canonicalDir([0.1, -0.9, 0])).toEqual([-0.1 / Math.hypot(0.1, 0.9), 0.9 / Math.hypot(0.1, 0.9), 0]);
    expect(canonicalDir([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("commits the origin as a name, the middle as a line and a pick with its reference", () => {
    expect(circularAxisFields("origin", "Z", [20, 15, 5], null)).toEqual({ axis: "Z" });
    expect(circularAxisFields("centre", "Z", [20, 15, 5], null)).toEqual({
      axis: { origin: [20, 15, 5], dir: [0, 0, 1] },
    });
    const picked = { origin: [30, 30, 0] as [number, number, number], dir: [0, 0, 1] as [number, number, number], ref };
    expect(circularAxisFields("picked", "X", [0, 0, 0], picked)).toEqual({
      axis: { origin: [30, 30, 0], dir: [0, 0, 1] },
      axisRef: ref,
    });
  });

  it("previews the same line it commits", () => {
    expect(axisLine("origin", "Y", [5, 5, 5], null)).toEqual({ origin: [0, 0, 0], dir: [0, 1, 0] });
    expect(axisLine("centre", "Z", [5, 5, 5], null)).toEqual({ origin: [5, 5, 5], dir: [0, 0, 1] });
  });

  it("says where the axis is", () => {
    expect(describeAxis("Z", undefined)).toBe("Z through the origin");
    expect(describeAxis({ origin: [20, 15, 0], dir: [0, 0, 1] }, undefined)).toBe("line through (20, 15, 0)");
    expect(describeAxis({ origin: [0, 0, 0], dir: [0, 0, 1] }, ref)).toBe("picked on the model");
    expect(describeAxis({ datum: "ax1" }, undefined, (id) => (id === "ax1" ? "Axis" : undefined))).toBe("Axis");
  });
});

describe("the circular pattern's Axis row", () => {
  const ax = { id: "ax1", type: "datumAxis", origin: [0, 0, 0], dir: [0, 0, 1], name: "Spindle" } as unknown as Feature;
  const pc = (o: Record<string, unknown>) =>
    ({ id: "pc", type: "patternCircular", count: 6, angle: 360, ...o }) as unknown as Feature;

  it("offers the world axes and the datum axes above the pattern", () => {
    const { options, current } = patternAxisChoice(pc({ axis: "Z" }), [ax, pc({ axis: "Z" })]);
    expect(options.map((o) => o.label)).toEqual(["X", "Y", "Z", "Spindle"]);
    expect(current).toBe("Z");
    expect(patternAxisChoice(pc({ axis: { datum: "ax1" } }), [ax, pc({ axis: { datum: "ax1" } })]).current).toBe("ax1");
  });

  it("writes a datum axis as {datum}, never the bare id an older build reads as Z", () => {
    expect(patternAxisPatch("ax1")).toEqual({ axis: { datum: "ax1" }, axisRef: undefined });
    expect(patternAxisPatch("Y")).toEqual({ axis: "Y", axisRef: undefined });
    expect(patternAxisPatch(PLACED_AXIS)).toBeNull();
  });

  it("does not offer a datum axis below the pattern", () => {
    const { options } = patternAxisChoice(pc({ axis: "Z" }), [pc({ axis: "Z" }), ax]);
    expect(options.map((o) => o.value)).toEqual(["X", "Y", "Z"]);
  });

  it("shows a placed axis as what it is, never as Z", () => {
    const line = pc({ axis: { origin: [20, 15, 0], dir: [0, 0, 1] } });
    expect(patternAxisChoice(line, [line])).toMatchObject({ current: PLACED_AXIS });
    expect(patternAxisChoice(line, [line]).options.at(-1)?.label).toBe("Line");
    const picked = pc({ axis: { origin: [20, 15, 0], dir: [0, 0, 1] }, axisRef: { kind: "edge", by: "nearest", point: [0, 0, 0] } });
    expect(patternAxisChoice(picked, [picked]).options.at(-1)?.label).toBe("Picked");
  });
});
