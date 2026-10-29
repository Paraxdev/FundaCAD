import { describe, expect, it } from "vitest";

import { rovingIndex, rovingStop } from "../../../src/components/ui/useRovingFocus";

const none = [false, false, false, false];

describe("rovingIndex", () => {
  it("moves along a horizontal group and wraps at both ends", () => {
    expect([
      rovingIndex("ArrowRight", 0, none),
      rovingIndex("ArrowRight", 3, none),
      rovingIndex("ArrowLeft", 0, none),
      rovingIndex("ArrowLeft", 2, none),
    ]).toEqual([1, 0, 3, 1]);
  });

  it("goes to the first and last enabled item on Home and End", () => {
    const d = [true, false, false, true];
    expect([rovingIndex("Home", 2, d), rovingIndex("End", 1, d)]).toEqual([1, 2]);
  });

  it("skips disabled items, wrapping past them", () => {
    const d = [false, true, true, false];
    expect([rovingIndex("ArrowRight", 0, d), rovingIndex("ArrowRight", 3, d), rovingIndex("ArrowLeft", 0, d)]).toEqual([
      3, 0, 3,
    ]);
  });

  it("stays at the end without wrap, the key still handled", () => {
    const opts = { wrap: false };
    expect([rovingIndex("ArrowRight", 3, none, opts), rovingIndex("ArrowLeft", 0, none, opts)]).toEqual([3, 0]);
  });

  it("answers only the arrows of its orientation", () => {
    const v = { orientation: "vertical" as const };
    const both = { orientation: "both" as const };
    expect([
      rovingIndex("ArrowDown", 0, none),
      rovingIndex("ArrowDown", 0, none, v),
      rovingIndex("ArrowRight", 0, none, v),
      rovingIndex("ArrowUp", 0, none, v),
      rovingIndex("ArrowDown", 0, none, both),
      rovingIndex("ArrowLeft", 0, none, both),
      rovingIndex("Enter", 0, none),
    ]).toEqual([null, 1, null, 3, 1, 3, null]);
  });

  it("starts from the ends when nothing is focused, and has nowhere to go when all are disabled", () => {
    expect([
      rovingIndex("ArrowRight", -1, none),
      rovingIndex("ArrowLeft", -1, none),
      rovingIndex("ArrowRight", 0, [true, true]),
      rovingIndex("Home", -1, []),
    ]).toEqual([0, 3, null, null]);
  });
});

describe("rovingStop", () => {
  it("is the active item, or the first enabled one when it is disabled or unset", () => {
    expect([
      rovingStop(2, none),
      rovingStop(0, [true, false, false]),
      rovingStop(-1, [true, true, false]),
      rovingStop(9, none),
      rovingStop(0, [true, true]),
    ]).toEqual([2, 1, 2, 0, -1]);
  });
});
