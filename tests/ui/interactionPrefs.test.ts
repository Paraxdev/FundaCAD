import { describe, expect, it } from "vitest";
import {
  asDwellMs, DEFAULT_DWELL_MS, getHoverDwellMs, MAX_DWELL_MS, MIN_DWELL_MS, onHoverDwellChange, setHoverDwellMs,
} from "../../src/ui/interactionPrefs";

describe("hover delay preference", () => {
  it("starts at the default", () => {
    expect(getHoverDwellMs()).toBe(DEFAULT_DWELL_MS);
  });

  it("clamps what it is given and refuses what is not a number", () => {
    expect(asDwellMs(50)).toBe(MIN_DWELL_MS);
    expect(asDwellMs("9000")).toBe(MAX_DWELL_MS);
    expect(asDwellMs("soon")).toBeNull();
  });

  it("tells its listeners when it changes", () => {
    let calls = 0;
    const stop = onHoverDwellChange(() => calls++);
    setHoverDwellMs(1200);
    setHoverDwellMs(1200);
    stop();
    expect(calls).toBe(1);
    expect(getHoverDwellMs()).toBe(1200);
  });
});
