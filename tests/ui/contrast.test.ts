import { describe, expect, it } from "vitest";
import { contrastRatio, describeFailures, lightness, mix, parseColor } from "../../src/ui/contrast";

describe("contrast maths", () => {
  it("parses every colour form a palette accepts", () => {
    expect(parseColor("#fff")).toEqual([255, 255, 255, 1]);
    expect(parseColor("#0008")).toEqual([0, 0, 0, 0x88 / 255]);
    expect(parseColor("#9b95ad")).toEqual([155, 149, 173, 1]);
    expect(parseColor("#9b95ad80")).toEqual([155, 149, 173, 128 / 255]);
    expect(parseColor("rgba(255, 92, 92, 0.14)")).toEqual([255, 92, 92, 0.14]);
    expect(parseColor("rgb(10 20 30 / 50%)")).toEqual([10, 20, 30, 0.5]);
    expect(() => parseColor("color-mix(in srgb, red, blue)")).toThrow();
    expect(() => parseColor("rgb(1, 2)")).toThrow();
  });

  it("gives the WCAG ratio, compositing a translucent foreground first", () => {
    expect(contrastRatio(parseColor("#000"), parseColor("#fff"))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor("#777"), parseColor("#fff"))).toBeCloseTo(4.48, 2);
    expect(contrastRatio(parseColor("rgba(0, 0, 0, 0)"), parseColor("#fff"))).toBeCloseTo(1, 5);
  });

  it("mixes like color-mix in srgb and measures CIE lightness", () => {
    expect(mix(parseColor("#000"), 0.5, parseColor("#fff"))).toEqual([127.5, 127.5, 127.5, 1]);
    expect(lightness(parseColor("#fff"))).toBeCloseTo(100, 3);
    expect(lightness(parseColor("#000"))).toBe(0);
    expect(lightness(parseColor("#777"))).toBeCloseTo(50, 0);
  });
});

describe("describeFailures", () => {
  const pair = (what: string, ratio: number, min: number) => ({ what, ratio, min });

  it("says nothing when every pair passes", () => {
    expect(describeFailures([])).toBe("");
  });

  it("names one pair with its ratio and the bar it misses, and a lightness gap without a ratio sign", () => {
    expect(describeFailures([pair("--text-mute on --panel", 2.61, 4.5)])).toBe(
      "1 colour pair falls short of contrast: --text-mute on --panel at 2.61:1, needs 4.5:1.",
    );
    expect(describeFailures([pair("--ok and --warn apart in lightness", 6.2, 10)])).toBe(
      "1 colour pair falls short of contrast: --ok and --warn apart in lightness by 6.2, needs 10.",
    );
  });

  it("names the worst few in order and counts the rest", () => {
    const failing = Array.from({ length: 7 }, (_, i) => pair(`--t${i} on --panel`, 1 + i / 10, 4.5));
    expect(describeFailures(failing, 2)).toBe(
      "7 colour pairs fall short of contrast, worst first: --t0 on --panel at 1:1, needs 4.5:1; " +
        "--t1 on --panel at 1.1:1, needs 4.5:1; and 5 more.",
    );
  });
});
