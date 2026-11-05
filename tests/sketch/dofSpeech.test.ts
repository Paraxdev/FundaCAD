import { describe, it, expect } from "vitest";
import { DofSpeech } from "../../src/sketch/dofSpeech";

describe("DofSpeech", () => {
  it("is silent until ready, and the first ready summary is only the baseline", () => {
    const s = new DofSpeech();
    expect(s.next("Not constrained", false, false)).toBeNull();
    expect(s.next("3 degrees of freedom", false, false)).toBeNull();
    expect(s.next("5 degrees of freedom", false, true)).toBeNull();
    expect(s.next("2 degrees of freedom", false, true)).toEqual({ text: "2 degrees of freedom", priority: "polite" });
  });

  it("says a change once and stays silent for the same text", () => {
    const s = new DofSpeech();
    s.next("7 degrees of freedom", false, true);
    expect(s.next("4 degrees of freedom", false, true)).toEqual({ text: "4 degrees of freedom", priority: "polite" });
    expect(s.next("4 degrees of freedom", false, true)).toBeNull();
    expect(s.next("1 degree of freedom", false, true)).toEqual({ text: "1 degree of freedom", priority: "polite" });
    expect(s.next("Fully defined", false, true)).toEqual({ text: "Fully defined", priority: "polite" });
  });

  it("says a conflict assertively and the way back politely", () => {
    const s = new DofSpeech();
    s.next("2 degrees of freedom", false, true);
    expect(s.next("Conflicting constraints", true, true)).toEqual({
      text: "Conflicting constraints",
      priority: "assertive",
    });
    expect(s.next("Conflicting constraints", true, true)).toBeNull();
    expect(s.next("2 degrees of freedom", false, true)).toEqual({
      text: "2 degrees of freedom",
      priority: "polite",
    });
  });

  it("does not record a summary seen before ready, so entry never speaks", () => {
    const s = new DofSpeech();
    s.next("Conflicting constraints", true, false);
    expect(s.next("Conflicting constraints", true, true)).toBeNull();
  });

  // An empty sketch is ready at once, and its first constraint is often a dimension, whose solve leaves ready false.
  it("keeps speaking changes once it has a baseline, whatever ready says", () => {
    const s = new DofSpeech();
    expect(s.next("Not constrained", false, true)).toBeNull();
    expect(s.next("Not constrained", false, false)).toBeNull();
    expect(s.next("3 degrees of freedom", false, false)).toEqual({ text: "3 degrees of freedom", priority: "polite" });
    expect(s.next("3 degrees of freedom", false, false)).toBeNull();
    expect(s.next("Conflicting constraints", true, false)).toEqual({
      text: "Conflicting constraints",
      priority: "assertive",
    });
    expect(s.next("Not constrained", false, true)).toEqual({ text: "Not constrained", priority: "polite" });
  });

  it("starts silent again after reset, for a second sketch", () => {
    const s = new DofSpeech();
    s.next("6 degrees of freedom", false, true);
    s.next("3 degrees of freedom", false, true);
    s.reset();
    expect(s.next("9 degrees of freedom", false, true)).toBeNull();
    expect(s.next("Fully defined", false, true)).toEqual({ text: "Fully defined", priority: "polite" });
  });
});
