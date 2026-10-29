// Larger click targets: the stored choice puts data-targets="large" on <html>, which lifts --hit-min to 32 px.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let stored: Map<string, string>;
let dataset: Record<string, string>;

function boot(entries: Record<string, string> = {}) {
  stored = new Map(Object.entries(entries));
  dataset = {};
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
  });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {} }));
  vi.stubGlobal("document", { documentElement: { dataset } });
}

async function load() {
  vi.resetModules();
  const prefs = await import("../../src/ui/a11yPrefs");
  const targets = await import("../../src/ui/targets");
  return { ...prefs, ...targets };
}

beforeEach(() => boot());
afterEach(() => vi.unstubAllGlobals());

describe("Larger click targets", () => {
  it("is off by default and leaves <html> without data-targets", async () => {
    const m = await load();
    expect(m.a11yPrefs().targets).toBe("default");
    expect(m.largeTargetsOn()).toBe(false);
    expect("targets" in dataset).toBe(false);
  });

  it("applies a stored choice before the app renders", async () => {
    boot({ "fundacad.a11y.targets": "large" });
    const m = await load();
    expect(m.largeTargetsOn()).toBe(true);
    expect(dataset.targets).toBe("large");
  });

  it("ignores a stored value it does not know", async () => {
    boot({ "fundacad.a11y.targets": "huge" });
    const m = await load();
    expect(m.a11yPrefs().targets).toBe("default");
    expect("targets" in dataset).toBe(false);
  });

  it("follows the setting both ways and stores it", async () => {
    const m = await load();
    m.setLargeTargets(true);
    expect(dataset.targets).toBe("large");
    expect(stored.get("fundacad.a11y.targets")).toBe("large");
    m.setLargeTargets(false);
    expect("targets" in dataset).toBe(false);
    expect(stored.get("fundacad.a11y.targets")).toBe("default");
  });

  it("is cleared by Reset", async () => {
    boot({ "fundacad.a11y.targets": "large" });
    const m = await load();
    m.resetA11yPrefs();
    expect(stored.has("fundacad.a11y.targets")).toBe(false);
    expect("targets" in dataset).toBe(false);
  });

  it("survives a context without a document", async () => {
    vi.stubGlobal("document", undefined);
    const m = await load();
    expect(() => m.setLargeTargets(true)).not.toThrow();
    expect(m.largeTargetsOn()).toBe(true);
  });
});
