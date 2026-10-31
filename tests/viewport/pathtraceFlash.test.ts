import { describe, expect, it } from "vitest";
// @ts-expect-error an e2e helper in plain CommonJS, with no types.
import flash from "../../e2e/lib/flash.cjs";

const { analyse, blackEdges, concurrentFlashesPerSecond, flashesPerSecond, isBand, toGrid } = flash;

const COLS = 8;
const ROWS = 5;
const plain = (v: number) => new Float32Array(COLS * ROWS).fill(v);
const steps = (values: number[], ms: number) => values.map((v, i) => ({ t: i * ms, lum: plain(v) }));
const alternating = (n: number, a: number, b: number) => Array.from({ length: n }, (_, i) => (i % 2 ? b : a));

function withBlackBelow(row: number) {
  const lum = plain(0.3);
  lum.fill(0, row * COLS);
  return lum;
}

describe("flash analysis of shown frames", () => {
  it("reads sRGB into relative luminance per cell", () => {
    const rgba = new Uint8Array(4 * 4).fill(255);
    rgba.fill(0, 0, 8);
    const grid = toGrid(rgba, 2, 2, 1, 2);
    expect(grid[0]).toBeCloseTo(0, 5);
    expect(grid[1]).toBeCloseTo(1, 5);
  });

  it("counts a light and dark swing at 8 Hz as eight flashes", () => {
    expect(flashesPerSecond(steps(alternating(40, 0.1, 0.6), 62.5))).toBe(8);
  });

  it("passes three flashes a second and fails three and a half", () => {
    const at = (changes: number) => {
      const v: number[] = [];
      for (let i = 0; i <= changes; i++) v.push(i % 2 ? 0.6 : 0.1);
      return steps(v, 1000 / (changes + 1));
    };
    expect(flashesPerSecond(at(6))).toBeLessThanOrEqual(3);
    expect(flashesPerSecond(at(7))).toBeGreaterThan(3);
  });

  it("ignores a swing under 10 percent of full luminance", () => {
    expect(flashesPerSecond(steps(alternating(60, 0.2, 0.28), 16))).toBe(0);
  });

  it("ignores a swing where the darker image is above 0.80", () => {
    expect(flashesPerSecond(steps(alternating(60, 0.82, 0.98), 16))).toBe(0);
  });

  it("ignores a flash over less than a quarter of the frame", () => {
    const frames = alternating(60, 0, 1).map((v, i) => {
      const lum = plain(0.3);
      lum.fill(v, 0, COLS);
      return { t: i * 16, lum };
    });
    expect(flashesPerSecond(frames)).toBe(0);
  });

  it("counts a slow fade up and down as one flash", () => {
    const ramp = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1];
    expect(flashesPerSecond(steps(ramp, 40))).toBe(1);
  });

  describe("concurrent count", () => {
    const NOISE_COLS = 40;
    const NOISE_ROWS = 25;
    // A fixed generator, so a read near the limit is the same on every run.
    function noiseFrames(n: number, ms: number, low: number, spread: number) {
      let seed = 12345;
      const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
      return Array.from({ length: n }, (_, i) => ({
        t: i * ms,
        lum: Float32Array.from({ length: NOISE_COLS * NOISE_ROWS }, () => low + spread * next()),
      }));
    }

    it("reads noise that differs per frame low, while the cell count reads it high", () => {
      const noise = noiseFrames(120, 16, 0.1, 0.2);
      expect(flashesPerSecond(noise)).toBeGreaterThan(3);
      expect(concurrentFlashesPerSecond(noise)).toBe(0);
    });

    it("reads a true flash high, as the cell count does", () => {
      const swing = steps(alternating(40, 0.1, 0.6), 62.5);
      expect(concurrentFlashesPerSecond(swing)).toBe(8);
      expect(flashesPerSecond(swing)).toBe(8);
    });

    it("reads a flash through noise high", () => {
      const noise = noiseFrames(80, 16, 0.1, 0.05);
      const frames = noise.map((f, i) => ({ t: f.t, lum: f.lum.map((v) => v + (Math.floor(i / 4) % 2) * 0.4) }));
      expect(concurrentFlashesPerSecond(frames)).toBeGreaterThan(3);
    });

    it("passes three flashes a second and fails three and a half", () => {
      const at = (changes: number) => {
        const v: number[] = [];
        for (let i = 0; i <= changes; i++) v.push(i % 2 ? 0.6 : 0.1);
        return steps(v, 1000 / (changes + 1));
      };
      expect(concurrentFlashesPerSecond(at(6))).toBeLessThanOrEqual(3);
      expect(concurrentFlashesPerSecond(at(7))).toBeGreaterThan(3);
    });

    it("ignores a swing that is small, too bright or under a quarter of the frame", () => {
      expect(concurrentFlashesPerSecond(steps(alternating(60, 0.2, 0.28), 16))).toBe(0);
      expect(concurrentFlashesPerSecond(steps(alternating(60, 0.82, 0.98), 16))).toBe(0);
      const small = alternating(60, 0, 1).map((v, i) => {
        const lum = plain(0.3);
        lum.fill(v, 0, COLS);
        return { t: i * 16, lum };
      });
      expect(concurrentFlashesPerSecond(small)).toBe(0);
    });

    it("adds up a slow fade, even when its cells cross at different frames", () => {
      const ramp = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1];
      expect(concurrentFlashesPerSecond(steps(ramp, 40))).toBe(1);
      // Cell c starts its fade c frames late, so no one step moves a quarter of the frame.
      const staggered = Array.from({ length: 60 }, (_, i) => ({
        t: i * 16,
        lum: plain(0).map((_v, c) => 0.1 + 0.3 * Math.min(1, Math.max(0, (i - c) / 3))),
      }));
      expect(concurrentFlashesPerSecond(staggered)).toBe(0.5);
    });

    it("says when a run drew so few frames that its tracer looks dead", () => {
      expect(analyse(steps([0.2, 0.2, 0.2], 2000), COLS).tooFew).toBe(true);
      expect(analyse(steps([0.2, 0.2, 0.2, 0.2], 2000), COLS).tooFew).toBe(false);
    });

    it("catches the faintest swing just over the limit, however long its fade", () => {
      const halfFlash = 156.25;
      const triangle = Array.from({ length: 200 }, (_, i) => {
        const up = i % 20 < 10;
        const along = (i % 10) / 10;
        return { t: (i * halfFlash) / 10, lum: plain(0.2 + 0.101 * (up ? along : 1 - along)) };
      });
      expect(concurrentFlashesPerSecond(triangle)).toBe(3.5);
    });

    it("counts half of the frame going up as the other half goes down", () => {
      const frames = alternating(40, 0, 1).map((v, i) => ({
        t: i * 62.5,
        lum: plain(0).map((_v, c) => (c % 2 === v ? 0.6 : 0.1)),
      }));
      expect(concurrentFlashesPerSecond(frames)).toBe(8);
    });

    it("is reported beside the cell count by analyse", () => {
      expect(analyse(steps(alternating(40, 0.1, 0.6), 62.5), COLS)).toMatchObject({
        flashes: 8,
        concurrent: 8,
        overLimit: true,
        concurrentOverLimit: true,
      });
    });
  });

  it("finds the black rows below a partial frame", () => {
    expect(blackEdges(withBlackBelow(2), COLS)).toMatchObject({ top: 0, bottom: 3 });
    expect(isBand(withBlackBelow(2), COLS)).toBe(true);
    expect(isBand(plain(0.3), COLS)).toBe(false);
    expect(isBand(plain(0), COLS)).toBe(false);
  });

  it("flags a lit frame going black and a partial frame, and passes a steady run", () => {
    const steady = analyse(steps([0.3, 0.3, 0.31, 0.3], 16), COLS);
    expect(steady).toMatchObject({ bands: 0, blackFrames: 0, overLimit: false });
    const black = analyse(steps([0.3, 0, 0.3], 16), COLS);
    expect(black.blackFrames).toBe(1);
    const band = analyse(
      [
        { t: 0, lum: plain(0.3) },
        { t: 16, lum: withBlackBelow(2) },
      ],
      COLS,
    );
    expect(band.bands).toBe(1);
    expect(band.bad[0]).toMatchObject({ i: 1, band: true });
  });
});
