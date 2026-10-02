import { describe, expect, it } from "vitest";
import { STUTTER_CLEAR_MS, STUTTER_MS, STUTTER_WINDOW_MS, StutterWatch } from "../../src/viewport/stutterWatch";

/** Feed frames of `ms` until `durationMs` of drawing has passed; returns the last verdict. */
function feed(w: StutterWatch, ms: number, durationMs: number): boolean {
  let verdict = false;
  for (let t = 0; t < durationMs; t += ms) verdict = w.sample(ms);
  return verdict;
}

describe("StutterWatch", () => {
  it("stays quiet at 60 fps and at a power plan's 30 fps", () => {
    expect(feed(new StutterWatch(), 16.7, 10_000)).toBe(false);
    expect(feed(new StutterWatch(), 33.3, 10_000)).toBe(false);
  });

  it("flags a view drawing well under 20 fps once there is a window of it", () => {
    const w = new StutterWatch();
    expect(feed(w, 80, STUTTER_WINDOW_MS / 2)).toBe(false);
    expect(feed(w, 80, STUTTER_WINDOW_MS)).toBe(true);
  });

  it("needs more than a few very slow frames to reach a verdict", () => {
    const w = new StutterWatch();
    for (let i = 0; i < 5; i++) expect(w.sample(900)).toBe(false);
  });

  it("is not tripped by isolated long frames among fast ones", () => {
    const w = new StutterWatch();
    let verdict = false;
    for (let i = 0; i < 600; i++) verdict = w.sample(i % 10 === 0 ? 400 : 16.7);
    expect(verdict).toBe(false);
  });

  it("recovers once the frames speed up again", () => {
    const w = new StutterWatch();
    expect(feed(w, STUTTER_MS * 2, STUTTER_WINDOW_MS * 2)).toBe(true);
    expect(feed(w, 16.7, STUTTER_WINDOW_MS * 2)).toBe(false);
  });

  it("ignores a suspended window's gap and nonsense periods", () => {
    const w = new StutterWatch();
    expect(w.sample(60_000)).toBe(false);
    expect(w.sample(0)).toBe(false);
    expect(w.sample(Number.NaN)).toBe(false);
    expect(feed(w, 16.7, STUTTER_WINDOW_MS * 2)).toBe(false);
  });

  it("forgets everything on reset", () => {
    const w = new StutterWatch();
    feed(w, 80, STUTTER_WINDOW_MS * 2);
    w.reset();
    expect(w.sample(80)).toBe(false);
  });

  it("holds the verdict between the two lines, so it does not flicker", () => {
    const w = new StutterWatch();
    expect(feed(w, 80, STUTTER_WINDOW_MS * 2)).toBe(true);
    expect(feed(w, (STUTTER_MS + STUTTER_CLEAR_MS) / 2, STUTTER_WINDOW_MS * 2)).toBe(true);
    expect(feed(w, 33.3, STUTTER_WINDOW_MS * 2)).toBe(false);
    expect(feed(w, (STUTTER_MS + STUTTER_CLEAR_MS) / 2, STUTTER_WINDOW_MS * 2)).toBe(false);
  });

  it("does not flicker when 60 Hz frames land on 33 and 50 ms at random", () => {
    const w = new StutterWatch();
    expect(feed(w, 80, STUTTER_WINDOW_MS * 2)).toBe(true);
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let flips = 0;
    let last = true;
    for (let i = 0; i < 20_000; i++) {
      const v = w.sample(random() < 0.5 ? 33.3 : 50);
      if (v !== last) flips++;
      last = v;
    }
    expect(flips).toBe(0);
  });
});
