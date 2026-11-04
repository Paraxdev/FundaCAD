import { describe, expect, it } from "vitest";
import { stepMenuText } from "../../src/ui/canStep";

describe("stepMenuText", () => {
  it("is the bare verb with no step", () => {
    expect(stepMenuText("Undo", null)).toBe("Undo");
    expect(stepMenuText("Redo", "")).toBe("Redo");
  });

  it("puts the step after the verb", () => {
    expect(stepMenuText("Undo", "Fillet 2")).toBe("Undo Fillet 2");
    expect(stepMenuText("Redo", "Delete 3 steps")).toBe("Redo Delete 3 steps");
  });

  it("clips at 32 characters with an ellipsis, and 32 exactly stays whole", () => {
    const exact = "Move Bracket with the long name!";
    expect(exact).toHaveLength(32);
    expect(stepMenuText("Undo", exact)).toBe(`Undo ${exact}`);
    expect(stepMenuText("Undo", `${exact}X`)).toBe(`Undo ${exact}…`);
    expect(stepMenuText("Undo", exact.repeat(2))).toBe(`Undo ${exact}…`);
  });
});
