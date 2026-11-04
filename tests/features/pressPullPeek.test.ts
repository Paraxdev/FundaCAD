import { describe, expect, it } from "vitest";
import { peeksThrough } from "../../src/features/pressPullPeek";
import type { Feature, PressPullMode } from "../../src/types";

const push = (distance: number): Feature => ({
  id: "f9",
  type: "press-pull",
  face: { kind: "face", by: "nearest", point: [0, 0, 10] },
  distance,
  operation: distance >= 0 ? "join" : "cut",
});

describe("Press/Pull sees through the body", () => {
  it("only while Cut is the chosen mode and the push goes in", () => {
    expect(peeksThrough(push(-5), "cut")).toBe(true);
    expect(peeksThrough(push(7), "cut")).toBe(false);
    expect(peeksThrough(null, "cut")).toBe(false);
  });

  it("not once Join or another mode is chosen, even with the push still going in", () => {
    for (const mode of ["auto", "join", "new", "intersect"] as PressPullMode[]) {
      expect(peeksThrough(push(-5), mode)).toBe(false);
      expect(peeksThrough(push(7), mode)).toBe(false);
    }
  });
});
