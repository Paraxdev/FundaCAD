import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RENDER, asRenderPrefs, renderPrefs, setRenderPref } from "../../src/ui/renderPrefs";
import { setWorkspace } from "../../src/ui/workspace";
import { cleanViewOn, savedOverlays, setOverlay, setOverlaysOn, toggleCleanView } from "../../src/ui/viewMode";
import { OVERLAY_KINDS, allOverlaysOn } from "../../src/viewport/overlayKinds";

afterEach(() => {
  setWorkspace("model");
  setRenderPref("overlaysModel", DEFAULT_RENDER.overlaysModel);
  setRenderPref("overlaysRender", DEFAULT_RENDER.overlaysRender);
});

describe("overlay prefs", () => {
  it("open with every overlay shown", () => {
    expect(DEFAULT_RENDER.overlaysModel).toEqual({ on: true, kinds: allOverlaysOn() });
    expect(asRenderPrefs({}).overlaysRender).toEqual({ on: true, kinds: allOverlaysOn() });
  });

  it("keep a stored set and fill what an older file did not name", () => {
    const p = asRenderPrefs({ overlaysRender: { on: true, kinds: { edges: false } } });
    expect(p.overlaysRender.kinds.edges).toBe(false);
    expect(p.overlaysRender.kinds.grid).toBe(true);
    expect(p.overlaysModel.kinds.edges).toBe(true);
  });

  it("are saved per workspace", () => {
    setOverlay("edges", false, "model");
    expect(savedOverlays("model").kinds.edges).toBe(false);
    expect(savedOverlays("render").kinds.edges).toBe(true);
    setWorkspace("render");
    setOverlay("grid", false);
    expect(renderPrefs().overlaysRender.kinds.grid).toBe(false);
    expect(renderPrefs().overlaysModel.kinds.grid).toBe(true);
  });

  it("survive a reload through storage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { setItem: (k: string, v: string) => store.set(k, v), getItem: (k: string) => store.get(k) ?? null });
    try {
      setOverlay("stress", false, "render");
      const raw = store.get("fundacad.render");
      expect(raw).toBeDefined();
      expect(asRenderPrefs(JSON.parse(raw!)).overlaysRender.kinds.stress).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Clean view hides them all and brings back the exact set, kinds already off staying off", () => {
    setOverlay("grid", false, "model");
    setOverlay("origin", false, "model");
    const before = structuredClone(savedOverlays("model"));
    expect(toggleCleanView("model")).toBe(true);
    expect(cleanViewOn("model")).toBe(true);
    expect(savedOverlays("model").on).toBe(false);
    expect(savedOverlays("render").on).toBe(true);
    expect(toggleCleanView("model")).toBe(false);
    expect(savedOverlays("model")).toEqual(before);
  });

  it("the master switch leaves the kinds as they were", () => {
    setOverlay("handles", false, "model");
    setOverlaysOn(false, "model");
    setOverlaysOn(true, "model");
    for (const k of OVERLAY_KINDS) expect(savedOverlays("model").kinds[k]).toBe(k !== "handles");
  });
});
