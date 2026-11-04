import { afterEach, describe, expect, it, vi } from "vitest";

let stored: Map<string, string>;

async function boot(entries: Record<string, string> = {}) {
  vi.resetModules();
  stored = new Map(Object.entries(entries));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, String(v)),
    removeItem: (k: string) => void stored.delete(k),
  });
  return import("../../src/ui/stressLook");
}

afterEach(() => vi.unstubAllGlobals());

describe("stress look", () => {
  it("is perceptual and smooth while nothing is stored", async () => {
    const m = await boot();
    expect(m.stressLook()).toEqual({ ramp: "perceptual", bands: false });
  });

  it("reads back what was stored", async () => {
    const m = await boot({ "fundacad.stress.colourMap": "greyscale", "fundacad.stress.bands": "on" });
    expect(m.stressLook()).toEqual({ ramp: "greyscale", bands: true });
  });

  it("falls back on a value it does not know", async () => {
    for (const [ramp, bands] of [
      ["viridis", "1"],
      ["", "yes"],
      ["Rainbow", "true"],
    ] as const) {
      const m = await boot({ "fundacad.stress.colourMap": ramp, "fundacad.stress.bands": bands });
      expect(m.stressLook()).toEqual({ ramp: "perceptual", bands: false });
    }
  });

  it("keeps one setting when only the other is stored", async () => {
    const m = await boot({ "fundacad.stress.bands": "on" });
    expect(m.stressLook()).toEqual({ ramp: "perceptual", bands: true });
  });

  it("stores both keys on a change and tells a listener once", async () => {
    const m = await boot();
    const seen: unknown[] = [];
    m.onStressLookChange((l) => seen.push(l));
    m.setStressLook({ ramp: "rainbow" });
    expect(seen).toEqual([{ ramp: "rainbow", bands: false }]);
    expect(Object.fromEntries(stored)).toEqual({
      "fundacad.stress.colourMap": "rainbow",
      "fundacad.stress.bands": "off",
    });
    m.setStressLook({ bands: true });
    expect(Object.fromEntries(stored)).toEqual({
      "fundacad.stress.colourMap": "rainbow",
      "fundacad.stress.bands": "on",
    });
    expect(m.stressLook()).toEqual({ ramp: "rainbow", bands: true });
    expect(seen).toHaveLength(2);
  });

  it("is quiet when nothing changes", async () => {
    const m = await boot({ "fundacad.stress.colourMap": "greyscale" });
    const fn = vi.fn();
    m.onStressLookChange(fn);
    m.setStressLook({ ramp: "greyscale" });
    m.setStressLook({});
    m.setStressLook({ bands: false });
    expect(fn).not.toHaveBeenCalled();
    expect(stored.has("fundacad.stress.bands")).toBe(false);
  });

  it("refuses a ramp it does not know and keeps the look", async () => {
    const m = await boot();
    const fn = vi.fn();
    m.onStressLookChange(fn);
    m.setStressLook({ ramp: "viridis" as never });
    m.setStressLook({ bands: "maybe" as never });
    expect(m.stressLook()).toEqual({ ramp: "perceptual", bands: false });
    expect(fn).not.toHaveBeenCalled();
    expect(stored.size).toBe(0);
  });

  it("stops telling a listener once it unsubscribes, the others still hear", async () => {
    const m = await boot();
    const a = vi.fn();
    const b = vi.fn();
    const off = m.onStressLookChange(a);
    m.onStressLookChange(b);
    m.setStressLook({ ramp: "rainbow" });
    off();
    m.setStressLook({ ramp: "greyscale" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("keeps the look in memory when the store refuses a write", async () => {
    const m = await boot();
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("full");
      },
    });
    m.setStressLook({ ramp: "greyscale", bands: true });
    expect(m.stressLook()).toEqual({ ramp: "greyscale", bands: true });
  });
});
