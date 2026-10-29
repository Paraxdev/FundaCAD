// The Contrast setting: Standard, More or Maximum, the OS contrast request as the default while nothing is
// stored, followed live (the Rust answer lands after startup), and written as data-contrast on <html>.

import { afterEach, describe, expect, it, vi } from "vitest";

function fakeMedia(start: { contrast?: boolean; forced?: boolean }) {
  const os = { contrast: false, forced: false, ...start };
  const listeners = new Set<() => void>();
  const evaluate = (q: string) =>
    (q === "(prefers-contrast: more)" && os.contrast) || (q === "(forced-colors: active)" && os.forced);
  return {
    matchMedia: (q: string) => ({
      media: q,
      get matches() {
        return evaluate(q);
      },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    }),
    change(next: { contrast?: boolean; forced?: boolean }) {
      Object.assign(os, next);
      for (const fn of listeners) fn();
    },
  };
}

let stored: Map<string, string>;
let html: { dataset: Record<string, string> };

async function boot(os: { contrast?: boolean; forced?: boolean } = {}, entries: Record<string, string> = {}) {
  vi.resetModules();
  stored = new Map(Object.entries(entries));
  html = { dataset: {} };
  const media = fakeMedia(os);
  vi.stubGlobal("matchMedia", media.matchMedia);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, String(v)),
    removeItem: (k: string) => void stored.delete(k),
  });
  vi.stubGlobal("document", { documentElement: html });
  const prefs = await import("../../src/ui/a11yPrefs");
  const setting = await import("../../src/ui/contrastSetting");
  setting.initContrast();
  const changes = vi.fn();
  setting.onContrastChange(changes);
  return { ...prefs, ...setting, media, changes };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("@tauri-apps/api/core");
  vi.doUnmock("@tauri-apps/api/window");
});

describe("the Contrast default", () => {
  it("is Standard with no data-contrast when the OS asks for nothing", async () => {
    const m = await boot();
    expect(m.a11yPrefs().contrast).toBe("system");
    expect(m.contrastSetting()).toBe("standard");
    expect(html.dataset.contrast).toBeUndefined();
  });

  it("is More when the OS asks for more contrast or forces colours", async () => {
    let m = await boot({ contrast: true });
    expect(m.contrastSetting()).toBe("more");
    expect(html.dataset.contrast).toBe("more");
    m = await boot({ forced: true });
    expect(m.contrastSetting()).toBe("more");
  });

  it("follows an OS change while the app runs", async () => {
    const m = await boot();
    m.media.change({ contrast: true });
    expect(html.dataset.contrast).toBe("more");
    expect(m.changes).toHaveBeenCalledTimes(1);
    m.media.change({ contrast: false });
    expect(html.dataset.contrast).toBeUndefined();
    expect(m.changes).toHaveBeenCalledTimes(2);
  });

  it("turns More when the Rust answer lands after startup", async () => {
    const invoke = vi.fn(async () => ({ highContrast: true }));
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    vi.doMock("@tauri-apps/api/window", () => ({
      getCurrentWindow: () => ({ theme: async () => "dark", onThemeChanged: async () => () => {} }),
    }));
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const m = await boot();
    expect(html.dataset.contrast).toBeUndefined();
    await vi.waitFor(() => expect(html.dataset.contrast).toBe("more"));
    expect(m.changes).toHaveBeenCalled();
  });
});

describe("a stored Contrast", () => {
  it("wins over the OS either way", async () => {
    let m = await boot({ contrast: true }, { "fundacad.a11y.contrast": "standard" });
    expect(m.contrastSetting()).toBe("standard");
    expect(html.dataset.contrast).toBeUndefined();
    m.media.change({ contrast: false });
    m.media.change({ contrast: true });
    expect(m.changes).not.toHaveBeenCalled();
    m = await boot({}, { "fundacad.a11y.contrast": "maximum" });
    expect(m.contrastSetting()).toBe("maximum");
    expect(html.dataset.contrast).toBe("maximum");
  });

  it("ignores a value it does not know", async () => {
    const m = await boot({ contrast: true }, { "fundacad.a11y.contrast": "loud" });
    expect(m.a11yPrefs().contrast).toBe("system");
    expect(m.contrastSetting()).toBe("more");
  });

  it("is written on a change and stored under its key", async () => {
    const m = await boot();
    m.setA11yPref("contrast", "maximum");
    expect(html.dataset.contrast).toBe("maximum");
    expect(stored.get("fundacad.a11y.contrast")).toBe("maximum");
    expect(m.changes).toHaveBeenCalledTimes(1);
    m.setA11yPref("contrast", "standard");
    expect(html.dataset.contrast).toBeUndefined();
  });

  it("is dropped by Reset, which goes back to the OS default", async () => {
    const m = await boot({ contrast: true }, { "fundacad.a11y.contrast": "standard" });
    m.resetA11yPrefs();
    expect(stored.has("fundacad.a11y.contrast")).toBe(false);
    expect(m.contrastSetting()).toBe("more");
    expect(html.dataset.contrast).toBe("more");
  });
});
