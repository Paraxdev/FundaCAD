import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RENDER, renderPrefs, setRenderPref } from "../../src/ui/renderPrefs";
import { setWorkspace } from "../../src/ui/workspace";
import {
  PATH_TRACING_AUTO, PATH_TRACING_LATER, PATH_TRACING_OFF, asViewMode, chooseViewMode,
  effectiveViewMode, nextViewMode, pathTracedBlock, savedViewMode,
} from "../../src/ui/viewMode";

const fast = { lowPower: false, auto: false };
const perf = { lowPower: true, auto: false };
const weak = { lowPower: true, auto: true };

afterEach(() => {
  setWorkspace("model");
  setRenderPref("viewModeModel", DEFAULT_RENDER.viewModeModel);
  setRenderPref("viewModeRender", DEFAULT_RENDER.viewModeRender);
  vi.unstubAllGlobals();
});

describe("view mode state", () => {
  it("starts on Realtime in both workspaces", () => {
    expect(DEFAULT_RENDER.viewModeModel).toBe("realtime");
    expect(DEFAULT_RENDER.viewModeRender).toBe("realtime");
  });

  it("takes only the three modes", () => {
    expect(asViewMode("matcap")).toBe("matcap");
    expect(asViewMode("solid")).toBeNull();
    expect(asViewMode(1)).toBeNull();
    setRenderPref("viewModeModel", "junk" as never);
    expect(renderPrefs().viewModeModel).toBe("realtime");
  });

  it("stores the choice through setRenderPref", () => {
    setRenderPref("viewModeModel", "matcap");
    expect(renderPrefs().viewModeModel).toBe("matcap");
  });

  it("survives a restart", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.resetModules();
    const first = await import("../../src/ui/renderPrefs");
    first.setRenderPref("viewModeRender", "matcap");
    vi.resetModules();
    const second = await import("../../src/ui/renderPrefs");
    expect(second.renderPrefs().viewModeRender).toBe("matcap");
    expect(second.renderPrefs().viewModeModel).toBe("realtime");
  });

  it("keeps one mode per workspace", () => {
    expect(chooseViewMode("matcap", fast)).toBe(true);
    expect(savedViewMode()).toBe("matcap");
    setWorkspace("render");
    expect(savedViewMode()).toBe("realtime");
    chooseViewMode("realtime", fast);
    setWorkspace("model");
    expect(effectiveViewMode(fast)).toBe("matcap");
    expect(effectiveViewMode(fast, "render")).toBe("realtime");
  });
});

describe("Path traced while there is no tracer", () => {
  it("cannot be chosen, and a saved one draws as Realtime", () => {
    expect(chooseViewMode("pathtraced", fast)).toBe(false);
    expect(savedViewMode()).toBe("realtime");
    setRenderPref("viewModeModel", "pathtraced");
    expect(effectiveViewMode(fast)).toBe("realtime");
    expect(effectiveViewMode(perf)).toBe("realtime");
  });

  it("is skipped by Z and Shift+Z", () => {
    expect(nextViewMode("realtime", 1, fast)).toBe("matcap");
    expect(nextViewMode("matcap", 1, fast)).toBe("realtime");
    expect(nextViewMode("matcap", -1, fast)).toBe("realtime");
    expect(nextViewMode("realtime", -1, perf)).toBe("matcap");
  });

  it("says why, in the performance mode wording on a low power tier", () => {
    expect(pathTracedBlock(fast)).toEqual({ reason: "later", tooltip: "Path tracing arrives in a later update" });
    expect(PATH_TRACING_LATER).toBe("Path tracing arrives in a later update");
    expect(pathTracedBlock(perf)!.tooltip).toBe(
      "To avoid crashes or unintentional freezes path tracing has been turned off. To re-enable, turn off performance mode.",
    );
    expect(pathTracedBlock(weak)!.tooltip).toBe(
      "To avoid crashes or unintentional freezes path tracing has been turned off. To re-enable, turn off performance mode."
      + " This computer was detected as low powered, so turning off performance mode may not lift it.",
    );
    expect(pathTracedBlock(weak)!.tooltip).toBe(`${PATH_TRACING_OFF} ${PATH_TRACING_AUTO}`);
  });
});
