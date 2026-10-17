// Which tracer Path traced starts on. Auto prefers the native tracer where the
// web view has no WebGPU (Linux, macOS 14/15), and beside WebGPU only on the
// ray query path with its own denoise: the N2b bench measured that path 14x to
// 40x WebGPU's samples per second, while the software path is about WebGPU's
// speed, so there WebGPU and its browser denoise are preferred.

import type { TracerPref } from "../../ui/renderPrefs";
import type { TracerBackend } from "./backend";

export type TracerKind = "native" | "webgpu";

/** pt_probe's answer: whether the app has a native tracer, and which path. */
export interface NativeProbe {
  available: boolean;
  path?: "rayquery" | "software" | undefined;
  adapter?: string | undefined;
  denoise?: boolean | undefined;
  reason?: string | undefined;
}

export interface TracerEnv {
  webgpu: boolean;
  native: NativeProbe;
  /** Backends that faulted this session: the other one is preferred, and
   *  the host turns Path traced off at the second fault either way. */
  faulted?: ReadonlySet<TracerKind> | undefined;
}

export function chooseTracer(pref: TracerPref, env: TracerEnv): TracerKind | null {
  const usable = (k: TracerKind) => (k === "webgpu" ? env.webgpu : env.native.available);
  const nativeFirst = pref === "native"
    || (pref === "auto" && (!env.webgpu || (env.native.path === "rayquery" && env.native.denoise === true)));
  const order: TracerKind[] = nativeFirst ? ["native", "webgpu"] : ["webgpu", "native"];
  const left = order.filter(usable);
  if (left.every((k) => env.faulted?.has(k)) && left.length > 1) return null;
  return left.find((k) => !env.faulted?.has(k)) ?? left[0] ?? null;
}

/** `prefer` "websocket" skips the native shared buffers. */
export async function createTracerOf(kind: TracerKind, prefer?: string): Promise<TracerBackend> {
  if (kind === "native") return (await import("./nativeTracer")).createNativeTracer({ prefer });
  return (await import("./webgpuTracer")).createWebGpuTracer();
}
