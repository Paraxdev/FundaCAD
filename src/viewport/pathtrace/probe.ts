// Whether this web view can path trace: a real WebGPU adapter, not a software
// fallback. Asked once per session and kept.

export interface GpuProbe {
  webgpu: boolean;
  vendor: string;
  architecture: string;
  isFallbackAdapter: boolean;
  maxStorageBufferBindingSize: number;
  ms: number;
  error?: string;
}

interface AdapterLike {
  info?: { vendor?: string; architecture?: string; isFallbackAdapter?: boolean };
  isFallbackAdapter?: boolean;
  limits?: { maxStorageBufferBindingSize?: number };
}
interface GpuLike {
  requestAdapter(o?: { powerPreference?: string }): Promise<AdapterLike | null>;
}

let pending: Promise<GpuProbe> | null = null;
let result: GpuProbe | null = null;

export function gpuProbeResult(): GpuProbe | null {
  return result;
}

export function judgeAdapter(a: AdapterLike | null, ms: number): GpuProbe {
  if (!a) return { webgpu: false, vendor: "", architecture: "", isFallbackAdapter: false, maxStorageBufferBindingSize: 0, ms, error: "no adapter" };
  const fallback = a.info?.isFallbackAdapter ?? a.isFallbackAdapter ?? false;
  return {
    webgpu: !fallback,
    vendor: a.info?.vendor ?? "",
    architecture: a.info?.architecture ?? "",
    isFallbackAdapter: fallback,
    maxStorageBufferBindingSize: a.limits?.maxStorageBufferBindingSize ?? 0,
    ms,
  };
}

export function probeWebGpu(gpu: GpuLike | undefined = (globalThis.navigator as unknown as { gpu?: GpuLike } | undefined)?.gpu): Promise<GpuProbe> {
  if (pending) return pending;
  const t0 = performance.now();
  const done = (p: GpuProbe) => (result = p);
  if (!gpu) {
    pending = Promise.resolve(done({ ...judgeAdapter(null, 0), error: "navigator.gpu missing" }));
    return pending;
  }
  pending = gpu.requestAdapter({ powerPreference: "high-performance" }).then(
    (a) => done(judgeAdapter(a, performance.now() - t0)),
    (e: unknown) => done({ ...judgeAdapter(null, performance.now() - t0), error: String(e) }),
  );
  return pending;
}

export function describeProbe(p: GpuProbe | null): string {
  if (!p) return "WebGPU: checking";
  if (!p.webgpu) return `WebGPU: none (${p.isFallbackAdapter ? "software fallback adapter" : p.error ?? "no adapter"})`;
  const mib = Math.round(p.maxStorageBufferBindingSize / 1048576);
  return `WebGPU: ${p.vendor || "unknown"} ${p.architecture}, storage binding ${mib} MiB, probe ${Math.round(p.ms)} ms`;
}
