import { describe, it, expect } from "vitest";
import { sketchEscapeAction, type SketchEscapeState } from "../../src/sketch/escapeLayers";

const idle: SketchEscapeState = {
  offsetPick: false,
  dragging: false,
  pendingGeometry: false,
  selection: false,
  tool: "select",
};

describe("sketchEscapeAction", () => {
  it("never closes the sketch while a tool is holding something", () => {
    // The bug this whole module exists for: one Escape that both cancels the
    // half-drawn rectangle and leaves the sketch throws away the geometry AND
    // the session, and the user pressed one key expecting to lose the rectangle.
    expect(sketchEscapeAction({ ...idle, tool: "rectangle", pendingGeometry: true }))
      .toBe("cancel-geometry");
    expect(sketchEscapeAction({ ...idle, tool: "offset", offsetPick: true })).toBe("cancel-offset");
    expect(sketchEscapeAction({ ...idle, dragging: true })).toBe("cancel-drag");
  });

  it("gives up the tool before it gives up the sketch", () => {
    // Two rungs, in this order. A drawing tool that vanished and took the sketch
    // with it would make Escape unusable as "oops, wrong tool".
    expect(sketchEscapeAction({ ...idle, tool: "circle" })).toBe("arm-select");
    expect(sketchEscapeAction(idle)).toBe("close");
  });

  it("clears a selection before disarming the tool", () => {
    // A selection is the more local state: dropping the tool first would leave
    // the entities lit and the next Delete would still act on them, so the press
    // would look like it did nothing.
    expect(sketchEscapeAction({ ...idle, selection: true, tool: "select" })).toBe("clear-selection");
    expect(sketchEscapeAction({ ...idle, selection: true, tool: "line" })).toBe("clear-selection");
  });

  it("cancels the innermost thing when several are true at once", () => {
    // State overlaps constantly, a drag of a selected entity while a tool is
    // armed is three of these at the same time. Most local wins, every time.
    expect(
      sketchEscapeAction({
        offsetPick: true,
        dragging: true,
        pendingGeometry: true,
        selection: true,
        tool: "line",
      }),
    ).toBe("cancel-offset");
    expect(
      sketchEscapeAction({ ...idle, dragging: true, pendingGeometry: true, selection: true }),
    ).toBe("cancel-drag");
  });

  it("walks out one rung per press, and always reaches the exit", () => {
    // The promise the layering makes: every press clears exactly one thing and
    // the stack is finite, so repeating Escape always ends in "close". A rung
    // that cleared nothing (or that could be re-entered by its own cancel) would
    // be a sketch the user cannot leave by pressing Escape harder.
    let s: SketchEscapeState = { ...idle, tool: "arc", pendingGeometry: true, selection: true };
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const a = sketchEscapeAction(s);
      seen.push(a);
      if (a === "close") break;
      if (a === "cancel-geometry") s = { ...s, pendingGeometry: false }; // the tool STAYS armed
      if (a === "clear-selection") s = { ...s, selection: false };
      if (a === "arm-select") s = { ...s, tool: "select" };
    }
    expect(seen).toEqual(["cancel-geometry", "clear-selection", "arm-select", "close"]);
  });
});
