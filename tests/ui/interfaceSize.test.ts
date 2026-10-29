// Interface size: the stored setting and its gate, the steps and the cap, and how it reaches the page, the webview
// zoom under Tauri and the root zoom elsewhere.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import baseScss from "../../src/styles/_base.scss?raw";

const setZoom = vi.fn((_: number) => Promise.resolve());
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom }) }));

let stored: Map<string, string>;
let root: { style: { zoom: string }; dataset: Record<string, string> };

function boot(entries: Record<string, string> = {}, tauri = false) {
  stored = new Map(Object.entries(entries));
  root = { style: { zoom: "" }, dataset: {} };
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
  });
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("window", tauri ? { __TAURI_INTERNALS__: {} } : {});
}

async function load() {
  vi.resetModules();
  const prefs = await import("../../src/ui/a11yPrefs");
  const size = await import("../../src/ui/interfaceSize");
  return { ...prefs, ...size };
}

const KEY = "fundacad.a11y.interfaceSize";

beforeEach(() => {
  boot();
  setZoom.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("the gate", () => {
  it("takes every zoom step up to 200, as numbers and as stored strings", async () => {
    const m = await load();
    for (const v of [80, 90, 100, 110, 125, 150, 175, 200, "125", "200"]) expect(m.asInterfaceSize(v)).toBe(Number(v));
  });

  it("refuses sizes between the steps, past either end and anything not a number", async () => {
    const m = await load();
    for (const v of [130, 70, 250, 0, -100, "", "big", null, undefined, Number.NaN]) {
      expect(m.asInterfaceSize(v)).toBeNull();
    }
  });

  it("goes up to 200 percent, the largest step", async () => {
    const m = await load();
    expect(m.INTERFACE_SIZE_MAX).toBe(200);
    expect(m.INTERFACE_SIZES.at(-1)).toBe(200);
  });
});

describe("the stored size", () => {
  it("is 100 when nothing or nonsense is stored", async () => {
    expect((await load()).a11yPrefs().interfaceSize).toBe(100);
    boot({ [KEY]: "130" });
    expect((await load()).a11yPrefs().interfaceSize).toBe(100);
  });

  it("survives a restart", async () => {
    const m = await load();
    m.setA11yPref("interfaceSize", 125);
    expect(stored.get(KEY)).toBe("125");
    boot(Object.fromEntries(stored));
    expect((await load()).a11yPrefs().interfaceSize).toBe(125);
  });

  it("goes back to 100 with Reset to defaults", async () => {
    boot({ [KEY]: "150" });
    const m = await load();
    m.resetA11yPrefs();
    expect(m.a11yPrefs().interfaceSize).toBe(100);
    expect(stored.has(KEY)).toBe(false);
  });
});

describe("stepping", () => {
  it("walks the steps up to 200 and stops there", async () => {
    const m = await load();
    expect([1, 2, 3, 4, 5, 6].map(() => m.stepInterfaceSize(1))).toEqual([110, 125, 150, 175, 200, 200]);
  });

  it("walks the steps down to 80 and stops there", async () => {
    const m = await load();
    expect([1, 2, 3].map(() => m.stepInterfaceSize(-1))).toEqual([90, 80, 80]);
  });

  it("resets to 100", async () => {
    boot({ [KEY]: "80" });
    const m = await load();
    expect(m.resetInterfaceSize()).toBe(100);
    expect(m.a11yPrefs().interfaceSize).toBe(100);
  });
});

describe("applying it", () => {
  it("zooms the root outside Tauri and clears the zoom at 100", async () => {
    boot({ [KEY]: "125" });
    const m = await load();
    m.installInterfaceSize();
    expect(root.style.zoom).toBe("1.25");
    m.setA11yPref("interfaceSize", 100);
    expect(root.style.zoom).toBe("");
    expect(setZoom).not.toHaveBeenCalled();
  });

  it("sets the webview zoom under Tauri at boot, 100 included, and on every change", async () => {
    boot({}, true);
    const m = await load();
    m.installInterfaceSize();
    await vi.waitFor(() => expect(setZoom).toHaveBeenLastCalledWith(1));
    m.stepInterfaceSize(1);
    await vi.waitFor(() => expect(setZoom).toHaveBeenLastCalledWith(1.1));
    m.resetA11yPrefs();
    await vi.waitFor(() => expect(setZoom).toHaveBeenLastCalledWith(1));
    expect(root.style.zoom).toBe("");
  });

  it("zooms the root instead when the webview refuses the zoom, until a later webview zoom lands", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setZoom.mockImplementationOnce(() => Promise.reject(new Error("not allowed")));
    boot({ [KEY]: "150" }, true);
    const m = await load();
    expect(() => m.installInterfaceSize()).not.toThrow();
    await vi.waitFor(() => expect(root.style.zoom).toBe("1.5"));
    expect(root.dataset).toEqual({});
    m.stepInterfaceSize(1);
    await vi.waitFor(() => expect(setZoom).toHaveBeenLastCalledWith(1.75));
    await vi.waitFor(() => expect(root.style.zoom).toBe(""));
  });
});

describe("the first paint", () => {
  const deferred = () => {
    let done = () => {};
    const p = new Promise<void>((r) => (done = r));
    return { p, done };
  };

  it("hides the page under Tauri until a stored size other than 100 lands", async () => {
    const zoomed = deferred();
    setZoom.mockImplementationOnce(() => zoomed.p);
    boot({ [KEY]: "200" }, true);
    const m = await load();
    m.installInterfaceSize();
    expect(root.dataset).toEqual({ sizing: "" });
    await vi.waitFor(() => expect(setZoom).toHaveBeenCalledWith(2));
    expect(root.dataset).toEqual({ sizing: "" });
    zoomed.done();
    await vi.waitFor(() => expect(root.dataset).toEqual({}));
    expect(root.style.zoom).toBe("");
  });

  it("shows the page at once at 100, outside Tauri, and on a later change", async () => {
    boot({}, true);
    let m = await load();
    m.installInterfaceSize();
    expect(root.dataset).toEqual({});
    m.stepInterfaceSize(1);
    expect(root.dataset).toEqual({});
    boot({ [KEY]: "200" });
    m = await load();
    m.installInterfaceSize();
    expect(root.dataset).toEqual({});
  });

  it("shows the page anyway when the webview zoom never answers", async () => {
    vi.useFakeTimers();
    try {
      setZoom.mockImplementationOnce(() => new Promise<void>(() => {}));
      boot({ [KEY]: "200" }, true);
      const m = await load();
      m.installInterfaceSize();
      await vi.advanceTimersByTimeAsync(m.SIZING_HIDE_MS - 1);
      expect(root.dataset).toEqual({ sizing: "" });
      await vi.advanceTimersByTimeAsync(1);
      expect(root.dataset).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides the body, not the root, so the window keeps the theme background", () => {
    const base = baseScss.replace(/\r\n/g, "\n");
    expect(base).toContain("html[data-sizing] body {\n  opacity: 0;\n}");
  });
});
