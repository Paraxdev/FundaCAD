import { describe, expect, it, vi } from "vitest";
import { claimEscape, escapeClaimed } from "../../src/ui/escapeClaim";

describe("claimEscape", () => {
  it("holds the claim until after the event that releases it", () => {
    vi.useFakeTimers();
    const release = claimEscape();
    expect(escapeClaimed()).toBe(true);
    release();
    release();
    expect(escapeClaimed()).toBe(true);
    vi.runAllTimers();
    expect(escapeClaimed()).toBe(false);
    vi.useRealTimers();
  });
});
