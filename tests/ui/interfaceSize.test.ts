// Interface size: the stored setting and its gate, the steps and the cap, and how it reaches the page, the webview
// zoom under Tauri and the root zoom elsewhere.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import baseScss from "../../src/styles/_base.scss?raw";
import { wheelEvidence } from "../../src/viewport/navigator/wheelKind";

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

  it("zooms the root only by the rest when a refusal follows a webview zoom that landed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    boot({ [KEY]: "200" }, true);
    const m = await load();
    m.installInterfaceSize();
    await vi.waitFor(() => expect(root.dataset).toEqual({}));
    expect(setZoom).toHaveBeenLastCalledWith(2);
    setZoom.mockImplementationOnce(() => Promise.reject(new Error("not allowed")));
    m.stepInterfaceSize(-1);
    await vi.waitFor(() => expect(root.style.zoom).toBe("0.875"));
    setZoom.mockImplementationOnce(() => Promise.reject(new Error("not allowed")));
    m.stepInterfaceSize(1);
    await vi.waitFor(() => expect(setZoom).toHaveBeenLastCalledWith(2));
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

describe("the factors a wheel event's deltas may be divided by", () => {
  const settled = () => new Promise((r) => setTimeout(r, 0));
  const notch = (deltaY: number, wheelDeltaY: number) => ({
    deltaX: 0,
    deltaY,
    deltaMode: 0,
    shiftKey: false,
    ctrlKey: false,
    wheelDeltaY,
  });

  async function scalesAt(pct: number, dpr: number) {
    boot({}, true);
    vi.stubGlobal("devicePixelRatio", dpr);
    const m = await load();
    m.applyInterfaceSize(pct);
    await settled();
    await settled();
    return m.wheelScales();
  }

  it("is exactly 1 at 100 percent on a 100 percent display", async () => {
    expect(await scalesAt(100, 1)).toEqual([1]);
  });

  it("offers the device pixel ratio at 100 percent, and above it the zoom and not the product", async () => {
    expect(await scalesAt(100, 1.25)).toEqual([1, 1.25]);
    expect(await scalesAt(110, 1.375)).toEqual([1, 1.1]);
    expect(await scalesAt(110, 1.1)).toEqual([1, 1.1]);
    expect(await scalesAt(80, 1)).toEqual([1, 0.8]);
  });

  it("leaves the zoom out when the webview refused it, as then only the root is zoomed", async () => {
    setZoom.mockImplementationOnce(() => Promise.reject(new Error("no")));
    vi.spyOn(console, "warn").mockImplementationOnce(() => {});
    expect(await scalesAt(150, 1.25)).toEqual([1, 1.25]);
  });

  // Measured in Chromium with a page zoom and --force-device-scale-factor together: both deltas follow the zoom alone.
  it.each([
    [80, 1.25, 1, 125, -150],
    [90, 1.5, 1.35, 111.111, -133],
    [110, 1.25, 1.375, 90.909, -109],
    [110, 1.25, 1.375, 30.3, -109],
    [110, 1.5, 1.65, 90.909, -109],
    [125, 1.25, 1.5625, 80, -96],
    [125, 1.5, 1.875, 26.664, -96],
    [150, 1.5, 2.25, 66.667, -80],
    [175, 1.25, 2.1875, 57.143, -68],
    [200, 1.75, 3.5, 16.665, -60],
  ])("reads a notch at %s percent on a %s display as a mouse", async (pct, _os, dpr, deltaY, wheelDeltaY) => {
    const scales = await scalesAt(pct, dpr);
    expect(wheelEvidence(notch(deltaY, wheelDeltaY), false, scales)).toBe("mouse");
    expect(wheelEvidence(notch(-deltaY, -wheelDeltaY), false, scales)).toBe("mouse");
  });

  it.each([
    [110, 1.375],
    [125, 1.5625],
    [150, 2.25],
    [200, 3.5],
  ])("still reads a touchpad as a touchpad at %s percent, device pixel ratio %s", async (pct, dpr) => {
    const scales = await scalesAt(pct, dpr);
    const zoom = pct / 100;
    expect(wheelEvidence(notch(3.7 / zoom, -11), false, scales)).toBe("touchpad");
    expect(wheelEvidence(notch(37.3 / zoom, -53), false, scales)).toBe("touchpad");
    expect(wheelEvidence({ ...notch(60 / zoom, -72), deltaX: 2.5 }, false, scales)).toBe("touchpad");
  });
});
