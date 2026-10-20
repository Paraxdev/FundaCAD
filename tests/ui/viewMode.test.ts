import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RENDER, renderPrefs, setRenderPref } from "../../src/ui/renderPrefs";
import { setWorkspace } from "../../src/ui/workspace";
import {
  PATH_TRACING_AUTO, PATH_TRACING_NO_GPU, PATH_TRACING_OFF, asViewMode, bootViewMode, chooseViewMode,
  effectiveViewMode, nextViewMode, pathTracedBlock, requestPathTraced, resetPathTracedOverride, savedGround, savedViewMode,
  setGround,
} from "../../src/ui/viewMode";

const fast = { lowPower: false, auto: false, webgpu: true };
const perf = { lowPower: true, auto: false, webgpu: true };
const weak = { lowPower: true, auto: true, webgpu: true };
const noGpu = { lowPower: false, auto: false, webgpu: false };
const probing = { lowPower: false, auto: false };

afterEach(() => {
  resetPathTracedOverride();
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

describe("Path traced", () => {
  it("can be chosen on a WebGPU machine and Z cycles through it", () => {
    expect(pathTracedBlock(fast)).toBeNull();
    expect(chooseViewMode("pathtraced", fast)).toBe(true);
    expect(savedViewMode()).toBe("pathtraced");
    expect(effectiveViewMode(fast)).toBe("pathtraced");
    expect(nextViewMode("realtime", 1, fast)).toBe("pathtraced");
    expect(nextViewMode("pathtraced", 1, fast)).toBe("matcap");
    expect(nextViewMode("matcap", -1, fast)).toBe("pathtraced");
  });

  it("is greyed only where neither WebGPU nor a native tracer exists", () => {
    const none = { ...noGpu, native: { available: false } };
    expect(pathTracedBlock(none)).toEqual({
      reason: "nogpu", tooltip: "Path tracing needs a GPU tracer, which this system does not have",
    });
    expect(PATH_TRACING_NO_GPU).toBe("Path tracing needs a GPU tracer, which this system does not have");
    expect(chooseViewMode("pathtraced", none)).toBe(false);
    expect(nextViewMode("realtime", 1, none)).toBe("matcap");
  });

  it("runs on the native tracer where the web view has no WebGPU", () => {
    const linux = { ...noGpu, native: { available: true, path: "software" as const } };
    expect(pathTracedBlock(linux)).toBeNull();
    expect(chooseViewMode("pathtraced", linux)).toBe(true);
    expect(pathTracedBlock({ ...linux, lowPower: true })!.tooltip).toBe(PATH_TRACING_OFF);
    expect(pathTracedBlock({ ...linux, auto: true })!.tooltip).toBe(`${PATH_TRACING_OFF} ${PATH_TRACING_AUTO}`);
  });

  it("waits for the native probe while WebGPU is missing, not while WebGPU is there", () => {
    expect(pathTracedBlock(noGpu)?.reason).toBe("probing");
    expect(pathTracedBlock({ ...fast, native: undefined })).toBeNull();
  });

  it("waits for the probe without forgetting a saved choice", () => {
    expect(pathTracedBlock(probing)?.reason).toBe("probing");
    setRenderPref("viewModeModel", "pathtraced");
    expect(effectiveViewMode(probing)).toBe("realtime");
    expect(savedViewMode()).toBe("pathtraced");
    expect(effectiveViewMode(fast)).toBe("pathtraced");
  });

  it("drops to Realtime in performance mode and comes back when it is off", () => {
    setRenderPref("viewModeModel", "pathtraced");
    expect(effectiveViewMode(perf)).toBe("realtime");
    expect(effectiveViewMode(weak)).toBe("realtime");
    expect(savedViewMode()).toBe("pathtraced");
    expect(effectiveViewMode(fast)).toBe("pathtraced");
    expect(chooseViewMode("pathtraced", perf)).toBe(false);
    expect(nextViewMode("realtime", -1, perf)).toBe("matcap");
    expect(nextViewMode("realtime", 1, perf)).toBe("matcap");
  });

  it("says why, in the performance mode wording first on a low power tier", () => {
    expect(pathTracedBlock(perf)!.tooltip).toBe(
      "To avoid crashes or unintentional freezes path tracing has been turned off. To re-enable, turn off performance mode.",
    );
    expect(pathTracedBlock(weak)!.tooltip).toBe(
      "To avoid crashes or unintentional freezes path tracing has been turned off. To re-enable, turn off performance mode."
      + " This computer was detected as low powered, so turning off performance mode may not lift it.",
    );
    expect(pathTracedBlock(weak)!.tooltip).toBe(`${PATH_TRACING_OFF} ${PATH_TRACING_AUTO}`);
    expect(pathTracedBlock({ lowPower: true, auto: false, webgpu: false })!.tooltip).toBe(PATH_TRACING_OFF);
    expect(pathTracedBlock({ lowPower: true, auto: true })!.reason).toBe("perf");
  });
});

describe("after GPU faults", () => {
  it("stays off for the session and draws Realtime", () => {
    const broken = { ...fast, traceFault: true };
    expect(pathTracedBlock(broken)?.reason).toBe("fault");
    setRenderPref("viewModeModel", "pathtraced");
    expect(effectiveViewMode(broken)).toBe("realtime");
    expect(pathTracedBlock({ ...perf, traceFault: true })?.reason).toBe("perf");
  });
});

describe("crash guard", () => {
  it("opens in Realtime with a notice when the last start of the tracer died", () => {
    expect(bootViewMode("pathtraced", () => true)).toEqual({ mode: "realtime", notice: true });
    expect(bootViewMode("pathtraced", () => false)).toEqual({ mode: "pathtraced", notice: false });
    expect(bootViewMode("matcap", () => true)).toEqual({ mode: "matcap", notice: false });
    expect(bootViewMode("pathtraced", () => { throw new Error("no storage"); })).toEqual({ mode: "pathtraced", notice: false });
  });
});

describe("the session override of the performance block", () => {
  it("warns on the first click and enables on a second click while the warning shows", () => {
    expect(requestPathTraced(perf, 1000)).toEqual({ result: "warn", message: expect.stringContaining(PATH_TRACING_OFF) });
    expect(pathTracedBlock(perf)?.reason).toBe("perf");
    expect(requestPathTraced(perf, 2000).result).toBe("enabled");
    expect(pathTracedBlock(perf)).toBeNull();
    expect(pathTracedBlock(weak)).toBeNull();
    expect(chooseViewMode("pathtraced", perf)).toBe(true);
    expect(effectiveViewMode(perf)).toBe("pathtraced");
  });

  it("needs the second click while the warning is still showing", () => {
    requestPathTraced(perf, 1000);
    expect(requestPathTraced(perf, 1000 + 60000).result).toBe("warn");
    expect(pathTracedBlock(perf)?.reason).toBe("perf");
  });

  it("leaves a missing WebGPU and a GPU fault as hard disables", () => {
    const noGpuPerf = { lowPower: true, auto: false, webgpu: false };
    expect(requestPathTraced(noGpuPerf, 1000).result).toBe("blocked");
    expect(requestPathTraced(noGpuPerf, 1500).result).toBe("blocked");
    expect(pathTracedBlock(noGpuPerf)?.reason).toBe("perf");
    expect(chooseViewMode("pathtraced", noGpuPerf)).toBe(false);
    const faultPerf = { ...perf, traceFault: true };
    requestPathTraced(faultPerf, 1000);
    expect(requestPathTraced(faultPerf, 1500).result).toBe("blocked");
    expect(chooseViewMode("pathtraced", faultPerf)).toBe(false);
  });

  it("is in memory only", async () => {
    const before = JSON.stringify(renderPrefs());
    requestPathTraced(perf, 1000);
    requestPathTraced(perf, 1500);
    expect(JSON.stringify(renderPrefs())).toBe(before);
    const store = (globalThis as { localStorage?: Storage }).localStorage;
    for (let i = 0; store && i < store.length; i++) {
      expect(store.getItem(store.key(i)!) ?? "").not.toMatch(/override/i);
    }
    vi.resetModules();
    const fresh = await import("../../src/ui/viewMode");
    expect(fresh.pathTracedBlock(perf)?.reason).toBe("perf");
  });
});

describe("ground per workspace", () => {
  afterEach(() => {
    setRenderPref("groundModel", DEFAULT_RENDER.groundModel);
    setRenderPref("groundRender", DEFAULT_RENDER.groundRender);
  });

  it("reads and writes only the current workspace's choice", () => {
    setWorkspace("render");
    setGround("shadow");
    expect(renderPrefs().groundRender).toBe("shadow");
    expect(renderPrefs().groundModel).toBe("none");
    expect(savedGround()).toBe("shadow");
    expect(savedGround("model")).toBe("none");
    setGround("shadow", "model");
    setGround("none", "render");
    expect(savedGround("model")).toBe("shadow");
    expect(savedGround("render")).toBe("none");
  });
});
