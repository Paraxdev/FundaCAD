import { describe, expect, it } from "vitest";
import {
  BUDGET_STEPS, BUDGET_START, costProfile, FrameBudget, MAX_SLOTS, renderScaleFor, STEP_UP_MS, TARGET_MS, tracedPictureScale,
} from "../../src/viewport/pathtrace/budget";

/** A GPU whose frame time grows with the work handed to it. */
function gpu(msAtStart: number) {
  return (slots: number) => (msAtStart * slots) / BUDGET_START;
}

function run(b: FrameBudget, ms: (slots: number) => number, frames: number, start = 0, dt = 16) {
  const seen: number[] = [];
  for (let i = 0; i < frames; i++) {
    b.frame(ms(b.budget), start + i * dt);
    seen.push(b.budget);
  }
  return seen;
}

describe("path trace frame budget", () => {
  it("starts near the library default", () => {
    expect(new FrameBudget(4_000_000).budget).toBe(BUDGET_START);
    expect(BUDGET_START).toBe(262_144);
  });

  it("steps down until a slow GPU's frame fits the target", () => {
    const b = new FrameBudget(4_000_000);
    const ms = gpu(30);
    run(b, ms, 60);
    expect(b.budget).toBeLessThanOrEqual(100_000);
    expect(ms(b.budget)).toBeLessThanOrEqual(TARGET_MS);
  });

  it("steps up one step at a time, at most every half second, and stops once a frame covers every pixel", () => {
    const pixels = 1_200_000;
    const b = new FrameBudget(pixels);
    const seen = run(b, () => 4, 400);
    const ups = seen.filter((v, i) => i > 0 && v > seen[i - 1]!);
    expect(ups.length).toBeGreaterThan(0);
    expect(ups.length).toBeLessThanOrEqual(Math.floor((400 * 16) / STEP_UP_MS));
    for (let i = 1; i < seen.length; i++) {
      const at = BUDGET_STEPS.indexOf(seen[i]!);
      expect(at - BUDGET_STEPS.indexOf(seen[i - 1]!)).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...seen)).toBe(1_482_910);
  });

  it("holds still inside the dead band so the tracer's pool is not reallocated", () => {
    const b = new FrameBudget(4_000_000);
    const seen = run(b, () => 11, 100);
    expect(new Set(seen).size).toBe(1);
  });

  it("only ever hands out values from the step table", () => {
    const b = new FrameBudget(MAX_SLOTS * 2);
    const seen = [...run(b, gpu(80), 50), ...run(b, () => 1, 600, 2000)];
    for (const v of seen) expect(BUDGET_STEPS).toContain(v);
    expect(Math.max(...seen)).toBe(MAX_SLOTS);
    expect(BUDGET_STEPS[0]).toBe(16_384);
    expect(BUDGET_STEPS.at(-1)).toBe(2_097_152);
  });

  it("ignores a single long frame such as a shader compile", () => {
    const b = new FrameBudget(4_000_000);
    run(b, () => 8, 10);
    const before = b.budget;
    b.frame(200, 500);
    run(b, () => 8, 3, 516);
    expect(b.budget).toBe(before);
  });

  it("drops at most a factor of four per decision", () => {
    const b = new FrameBudget(4_000_000);
    run(b, () => 2500, 3);
    expect(b.budget).toBe(BUDGET_START / 4);
  });

  it("halves the ceiling on battery", () => {
    const b = new FrameBudget(4_000_000);
    b.setLimit(4_000_000, 0.5);
    expect(b.budget).toBeLessThanOrEqual(BUDGET_START / 2);
    run(b, () => 1, 400);
    expect(b.budget).toBe(MAX_SLOTS / 2);
  });

  it("shrinks with a smaller trace", () => {
    const b = new FrameBudget(4_000_000);
    b.setLimit(100_000, 1);
    expect(b.budget).toBe(131_072);
  });
});

describe("path trace cost profile", () => {
  it("caps samples, work and resolution on battery", () => {
    expect(costProfile({ discharging: true })).toEqual({ cap: 64, budgetScale: 0.5 });
    expect(costProfile({ discharging: false })).toEqual({ cap: 256, budgetScale: 1 });
  });

  it("traces at three quarters of the device pixels, half on a dense or large screen or on battery", () => {
    expect(renderScaleFor({ cssHeight: 900, dpr: 1, discharging: false })).toBe(0.75);
    expect(renderScaleFor({ cssHeight: 1600, dpr: 1, discharging: false })).toBe(0.5);
    expect(renderScaleFor({ cssHeight: 900, dpr: 1, discharging: true })).toBe(0.5);
    // The canvas is already drawn at CSS size, which is half the device pixels at 2x.
    expect(renderScaleFor({ cssHeight: 900, dpr: 2, discharging: false })).toBe(1);
    expect(renderScaleFor({ cssHeight: 900, dpr: 1.25, discharging: false })).toBeCloseTo(0.9375);
  });

  it("keeps a traced picture inside the pixel and texture limits", () => {
    expect(tracedPictureScale(1400, 864, 1, 8192)).toBe(1);
    expect(tracedPictureScale(1400, 864, 2, 8192)).toBe(2);
    const k = tracedPictureScale(1400, 864, 4, 8192);
    expect(1400 * k * 864 * k).toBeLessThanOrEqual(8_294_400);
    expect(tracedPictureScale(3000, 500, 4, 8192) * 3000).toBeLessThanOrEqual(8192);
  });
});
