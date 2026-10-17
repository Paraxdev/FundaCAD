// Whether this web view can path trace: a real WebGPU adapter, not a software
// fallback, and whether the app has a native tracer. Asked once per session
// and kept.

import type { NativeProbe } from "./choose";

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

/** Tracer::new takes 350 to 610 ms; a probe far past that is a stuck driver. */
const NATIVE_PROBE_TIMEOUT_MS = 8000;

/** Whether the app has a native tracer. Outside the app there is none. */
export function probeNative(
  call?: (cmd: string) => Promise<unknown>,
  timeoutMs = NATIVE_PROBE_TIMEOUT_MS,
): Promise<NativeProbe> {
  if (!call && !("__TAURI_INTERNALS__" in globalThis)) return Promise.resolve({ available: false, reason: "not in the app" });
  const ask = call ?? (async (cmd: string) => (await import("@tauri-apps/api/core")).invoke(cmd));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<NativeProbe>((resolve) => {
    timer = setTimeout(() => resolve({ available: false, reason: "the probe did not answer" }), timeoutMs);
  });
  const asked = ask("pt_probe").then(
    (p) => p as NativeProbe,
    (e: unknown) => ({ available: false, reason: String(e) }),
  );
  return Promise.race([asked, late]).finally(() => clearTimeout(timer));
}

export function describeNative(p: NativeProbe | null): string {
  if (!p) return "native tracer: checking";
  if (!p.available) return `native tracer: none (${p.reason ?? "no adapter"})`;
  return `native tracer: ${p.path === "rayquery" ? "ray query" : "software"}, ${p.adapter ?? "unknown"}${p.denoise ? ", denoise" : ""}`;
}
