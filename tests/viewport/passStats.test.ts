import { beforeAll, describe, expect, it, vi } from "vitest";
import { sceneStats } from "../../src/diagnostics/sceneStats";

const base = { model: null, canvas: { clientWidth: 10, clientHeight: 10 } as HTMLCanvasElement, pixelRatio: 1, frameMs: null };

describe("sceneStats pass timings", () => {
  beforeAll(() => { vi.stubGlobal("window", {}); });

  it("lists the median per pass and how it was measured", () => {
    const out = sceneStats({ ...base, passes: { ms: { shadow: 0.5, main: 3.256 }, kind: "timer-query" } });
    expect(out).toContain("[passes] shadow 0.50 · main 3.26 ms (timer-query)");
  });

  it("says so before the first results arrive", () => {
    const out = sceneStats({ ...base, passes: { ms: {}, kind: "fence" } });
    expect(out).toContain("[passes] no GPU timings yet (fence)");
  });
});

describe("sceneStats Path traced", () => {
  beforeAll(() => { vi.stubGlobal("window", {}); });

  it("names the backend, the samples, the adapter with its kind and the last fault", () => {
    const out = sceneStats({
      ...base,
      trace: {
        state: "trace", backend: "native shared (shm)", samples: 128, denoised: true, fault: "Path tracing gathered no sample in 10 seconds",
        gpu: "WebGPU: none (no adapter); native tracer: software, Apple Paravirtual device (Metal, integrated GPU)",
      },
    });
    expect(out).toContain("[trace] trace on native shared (shm) · 128 samples · denoised · last fault Path tracing gathered no sample in 10 seconds");
    expect(out).toContain("[trace] WebGPU: none (no adapter); native tracer: software, Apple Paravirtual device (Metal, integrated GPU)");
  });

  it("says when nothing traced and nothing faulted", () => {
    const out = sceneStats({ ...base, trace: { state: "off", backend: "", samples: 0, denoised: false, fault: null, gpu: "WebGPU: checking" } });
    expect(out).toContain("[trace] off on no tracer · 0 samples · last fault none");
  });
});
