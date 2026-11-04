import { describe, expect, it } from "vitest";
import { deltaE2000, lightness, type Rgba, type Vision } from "../../src/ui/contrast";
import {
  bandT,
  legendGradient,
  rampColor,
  STRESS_BANDS,
  STRESS_RAMPS,
  stressColors,
  type StressRamp,
} from "../../src/ui/stress";

const HEX: Record<StressRamp, string[]> = {
  perceptual: ["#440154", "#472d7b", "#3b528b", "#2c728e", "#21918c", "#28ae80", "#5ec962", "#addc30", "#fde725"],
  rainbow: ["#0000ff", "#00ffff", "#00ff00", "#ffff00", "#ff0000"],
  greyscale: ["#262626", "#f2f2f2"],
};

const rgba = (ramp: StressRamp, t: number): Rgba => {
  const [r, g, b] = rampColor(ramp, t);
  return [r * 255, g * 255, b * 255, 1];
};

const f32 = (v: number[]) => [...new Float32Array(v)];

const rgb255 = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16) / 255,
  Number.parseInt(hex.slice(3, 5), 16) / 255,
  Number.parseInt(hex.slice(5, 7), 16) / 255,
];

/** Smallest lightness gain over one tenth of the scale, 11 samples. */
function minLightnessStep(ramp: StressRamp): number {
  let min = Infinity;
  for (let i = 0; i < 10; i++) {
    min = Math.min(min, lightness(rgba(ramp, (i + 1) / 10)) - lightness(rgba(ramp, i / 10)));
  }
  return min;
}

/** Smallest CIEDE2000 between two samples at least a quarter of the scale apart, on a 0.05 grid. */
function minSeparation(ramp: StressRamp, vision: Vision): number {
  let min = Infinity;
  for (let i = 0; i <= 20; i++) {
    for (let j = i + 5; j <= 20; j++) {
      min = Math.min(min, deltaE2000(rgba(ramp, i / 20), rgba(ramp, j / 20), vision));
    }
  }
  return min;
}

describe("stress ramps", () => {
  it("lists Perceptual first, then Rainbow and Greyscale", () => {
    expect(STRESS_RAMPS.map((r) => r.value)).toEqual(["perceptual", "rainbow", "greyscale"]);
    expect(STRESS_RAMPS.map((r) => r.label)).toEqual(["Perceptual", "Rainbow", "Greyscale"]);
  });

  it.each(["perceptual", "greyscale"] as const)("%s rises in lightness by 5 L* at every tenth", (ramp) => {
    expect(minLightnessStep(ramp)).toBeGreaterThanOrEqual(5);
  });

  it.each(["perceptual", "greyscale"] as const)("%s keeps far samples apart in deuteranopia and protanopia", (ramp) => {
    expect(minSeparation(ramp, "deuteranopia")).toBeGreaterThanOrEqual(10);
    expect(minSeparation(ramp, "protanopia")).toBeGreaterThanOrEqual(10);
  });

  it("rainbow fails the lightness check, it falls", () => {
    expect(minLightnessStep("rainbow")).toBeLessThan(0);
  });

  it("rainbow fails both dichromat checks", () => {
    expect(minSeparation("rainbow", "deuteranopia")).toBeLessThan(10);
    expect(minSeparation("rainbow", "protanopia")).toBeLessThan(10);
  });

  it("perceptual and greyscale stops are the specified colours", () => {
    for (const ramp of ["perceptual", "greyscale"] as const) {
      const stops = HEX[ramp];
      const got = stops.map((_, i) => rampColor(ramp, i / (stops.length - 1)));
      const want = stops.map(rgb255);
      got.forEach((c, i) => c.forEach((v, k) => expect(v).toBeCloseTo(want[i]![k]!, 10)));
    }
  });

  it("rainbow keeps today's five stops", () => {
    const got = [0, 0.25, 0.5, 0.75, 1].map((t) => rampColor("rainbow", t));
    expect(got).toEqual(HEX.rainbow.map(rgb255));
  });

  it("blends linearly between stops, off the stop positions", () => {
    const [a, b] = [rgb255("#472d7b"), rgb255("#3b528b")];
    const got = rampColor("perceptual", 1.25 / 8);
    got.forEach((v, k) => expect(v).toBeCloseTo(a[k]! + (b[k]! - a[k]!) * 0.25, 10));
    expect(rampColor("greyscale", 0.3).map((v) => +v.toFixed(6))).toEqual(
      [0, 1, 2].map((k) => +(rgb255("#262626")[k]! + (rgb255("#f2f2f2")[k]! - rgb255("#262626")[k]!) * 0.3).toFixed(6)),
    );
  });

  it.each(["perceptual", "rainbow", "greyscale"] as const)(
    "%s clamps -0.3 and 1.7 and reads NaN as the low end",
    (ramp) => {
      expect(rampColor(ramp, -0.3)).toEqual(rampColor(ramp, 0));
      expect(rampColor(ramp, 1.7)).toEqual(rampColor(ramp, 1));
      expect(rampColor(ramp, NaN)).toEqual(rampColor(ramp, 0));
      expect(rampColor(ramp, 0)).not.toEqual(rampColor(ramp, 1));
    },
  );
});

describe("stressColors", () => {
  it("draws Perceptual unless told otherwise, over the value range", () => {
    const want = f32([0, 1, 0.5].flatMap((t) => rampColor("perceptual", t)));
    expect([...stressColors([12.5, 47.5, 30], 12.5, 47.5)]).toEqual(want);
    expect([...stressColors([12.5, 47.5, 30], 12.5, 47.5, "perceptual")]).toEqual(want);
  });

  it("takes the ramp it is given", () => {
    expect([...stressColors([20, 40, 30], 10, 40, "greyscale")]).toEqual(
      f32([1 / 3, 1, 2 / 3].flatMap((t) => rampColor("greyscale", t))),
    );
  });

  it("gives a flat field the low colour of the ramp", () => {
    const low = rampColor("perceptual", 0);
    expect([...stressColors([7.5, 7.5], 7.5, 7.5)]).toEqual(f32([...low, ...low]));
    const other = rampColor("rainbow", 0);
    expect([...stressColors([7.5], 7.5, 7.5, "rainbow")]).toEqual(f32(other));
  });
});

describe("legendGradient", () => {
  it("draws the Perceptual stops at 0, 12.5 ... 100 percent by default", () => {
    const want = HEX.perceptual
      .map((h, i) => {
        const [r, g, b] = rgb255(h).map((v) => Math.round(v * 255));
        return `rgb(${r}, ${g}, ${b}) ${i * 12.5}%`;
      })
      .join(", ");
    expect(legendGradient()).toBe(`linear-gradient(to right, ${want})`);
    expect(legendGradient("perceptual")).toBe(legendGradient());
  });

  it("draws Rainbow and Greyscale from their own stops", () => {
    expect(legendGradient("rainbow")).toBe(
      "linear-gradient(to right, rgb(0, 0, 255) 0%, rgb(0, 255, 255) 25%, rgb(0, 255, 0) 50%, rgb(255, 255, 0) 75%, rgb(255, 0, 0) 100%)",
    );
    expect(legendGradient("greyscale")).toBe("linear-gradient(to right, rgb(38, 38, 38) 0%, rgb(242, 242, 242) 100%)");
  });
});

describe("bands", () => {
  it("uses eight bands, so every second edge sits on a quarter mark", () => {
    expect(STRESS_BANDS).toBe(8);
  });

  it("takes the colour at the centre of the band, the edge itself belonging to the upper band", () => {
    expect([0, 0.1249, 0.125, 0.3, 0.999, 1].map((t) => bandT(t, 8))).toEqual([
      0.0625, 0.0625, 0.1875, 0.3125, 0.9375, 0.9375,
    ]);
    expect(bandT(0.5, 4)).toBe(0.625);
  });

  it("clamps outside the scale and reads NaN as the lowest band", () => {
    expect([-0.3, 1.7, NaN].map((t) => bandT(t, 8))).toEqual([0.0625, 0.9375, 0.0625]);
  });

  it("leaves t alone with no bands", () => {
    expect([0, 0.1249, 0.4, 1.7].map((t) => bandT(t, 0))).toEqual([0, 0.1249, 0.4, 1.7]);
  });

  it("paints banded vertices at their band centre, off the origin", () => {
    const grey = (t: number) => (38 + 204 * t) / 255;
    const values = [10, 14.9, 15, 33, 50];
    const centres = [0.0625, 0.0625, 0.1875, 0.5625, 0.9375];
    expect([...stressColors(values, 10, 50, "greyscale", 8)]).toEqual(
      f32(centres.flatMap((t) => [grey(t), grey(t), grey(t)])),
    );
    expect([...stressColors(values, 10, 50, "greyscale")]).not.toEqual([
      ...stressColors(values, 10, 50, "greyscale", 8),
    ]);
  });

  it("draws a banded legend of hard stops, each band colour at both its edges", () => {
    expect(legendGradient("greyscale", 2)).toBe(
      "linear-gradient(to right, rgb(89, 89, 89) 0%, rgb(89, 89, 89) 50%, rgb(191, 191, 191) 50%, rgb(191, 191, 191) 100%)",
    );
    const stops = legendGradient("perceptual", 8).match(/rgb\([^)]*\) [\d.]+%/g)!;
    expect(stops).toHaveLength(16);
    expect(stops.map((x) => x.split(") ")[1])).toEqual([
      "0%",
      "12.5%",
      "12.5%",
      "25%",
      "25%",
      "37.5%",
      "37.5%",
      "50%",
      "50%",
      "62.5%",
      "62.5%",
      "75%",
      "75%",
      "87.5%",
      "87.5%",
      "100%",
    ]);
    for (let i = 0; i < 16; i += 2)
      expect(stops[i]!.split(" ").slice(0, 3)).toEqual(stops[i + 1]!.split(" ").slice(0, 3));
    expect(new Set(stops.map((x) => x.split(")")[0])).size).toBe(8);
  });
});
