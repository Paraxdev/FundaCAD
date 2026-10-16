import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "./memoryStorage";
import {
  bedFit, bedFitMessage, bedSizeOf, parseCustomBedSize, BED_PRESETS,
} from "../../plugins/FundaCAD.PrintToolbox/bedFit";

describe("bedFit", () => {
  it("fits when every axis is within the bed, with scale 1", () => {
    expect(bedFit([100, 100, 100], [220, 220, 220])).toEqual({ fits: true, scale: 1 });
  });

  it("does not fit when any axis is over, and gives the limiting scale", () => {
    const { fits, scale } = bedFit([100, 300, 100], [220, 220, 220]);
    expect(fits).toBe(false);
    expect(scale).toBeCloseTo(220 / 300);
  });

  it("takes the smallest ratio across all 3 axes as the limiting one", () => {
    const { scale } = bedFit([400, 300, 50], [200, 100, 200]);
    // ratios: 0.5, 1/3, 4 -> the middle axis is the tightest
    expect(scale).toBeCloseTo(100 / 300);
  });

  it("exactly touching the bed counts as fitting", () => {
    expect(bedFit([220, 220, 220], [220, 220, 220]).fits).toBe(true);
  });
});

describe("bedFitMessage", () => {
  it("says it fits, with the bed and model size", () => {
    expect(bedFitMessage([100, 100, 100], [220, 220, 220])).toContain("Fits the 220 x 220 x 220 mm bed");
  });

  it("says it does not fit, with a scale to fix it", () => {
    const msg = bedFitMessage([100, 300, 100], [220, 220, 220]);
    expect(msg).toContain("Too big");
    expect(msg).toContain("%");
  });
});

describe("bedSizeOf", () => {
  it("resolves a preset id to its fixed size", () => {
    expect(bedSizeOf({ presetId: "300", customSize: [1, 1, 1] })).toEqual([300, 300, 300]);
  });

  it("falls back to the stored custom size for the custom preset", () => {
    expect(bedSizeOf({ presetId: "custom", customSize: [123, 456, 789] })).toEqual([123, 456, 789]);
  });

  it("lists every preset with a size except custom", () => {
    for (const p of BED_PRESETS) {
      if (p.id === "custom") expect(p.size).toBeNull();
      else expect(p.size).not.toBeNull();
    }
  });
});

describe("parseCustomBedSize", () => {
  it("accepts three positive finite numbers", () => {
    expect(parseCustomBedSize(220, 220, 250)).toEqual({ ok: true, size: [220, 220, 250] });
  });

  it("rejects zero or negative on any axis", () => {
    expect(parseCustomBedSize(0, 220, 250).ok).toBe(false);
    expect(parseCustomBedSize(220, -1, 250).ok).toBe(false);
  });

  it("rejects NaN, from an empty or unparsable field", () => {
    const result = parseCustomBedSize(NaN, 220, 250);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("positive");
  });

  it("rejects infinity", () => {
    expect(parseCustomBedSize(220, 220, Infinity).ok).toBe(false);
  });
});

describe("the bed choice as a setting", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("adopts the old key once and shows the custom size only for Custom", async () => {
    const store = new MemoryStorage();
    store.setItem("fundacad.printToolbox.bedFit", JSON.stringify({ presetId: "custom", customSize: [80, 90, 100] }));
    vi.stubGlobal("localStorage", store);
    vi.resetModules();
    const m = await import("../../plugins/FundaCAD.PrintToolbox/bedFit");
    expect(m.loadBedFitSetting()).toEqual({ presetId: "custom", customSize: [80, 90, 100] });
    const customX = m.BED_SETTINGS.props.find((p) => p.key === "customX")!;
    expect(customX.visibleWhen!({ presetId: "custom" })).toBe(true);
    expect(customX.visibleWhen!({ presetId: "256" })).toBe(false);
    m.saveBedFitSetting({ presetId: "300", customSize: [80, 90, 100] });
    expect(JSON.parse(store.getItem("fundacad.pluginSettings.FundaCAD.PrintToolbox")!).values.presetId).toBe("300");
  });
});
