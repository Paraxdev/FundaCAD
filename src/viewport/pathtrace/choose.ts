// Auto prefers native where the web view has no WebGPU (Linux, macOS 14/15), and on ray queries, which the N2b
// bench measured at 14x to 40x WebGPU's samples per second. The software path is about WebGPU's speed.

import type { TracerPref } from "../../ui/renderPrefs";
import type { TracerBackend } from "./backend";
import type { Call } from "./nativeScene";

export type TracerKind = "native" | "webgpu";

/** pt_probe's answer: whether the app has a native tracer, and which path. */
export interface NativeProbe {
  available: boolean;
  path?: "rayquery" | "software" | undefined;
  adapter?: string | undefined;
  denoise?: boolean | undefined;
  /** What cleans the cap; absent from an app older than the runtime load. */
  denoiser?: "oidn" | "filter" | undefined;
  reason?: string | undefined;
  /** Why it refused: the greying reason the page shows. */
  class?: "noadapter" | "cpu" | "limits" | "selfcheck" | undefined;
  /** What the refused adapter binds, with the limits class. */
  storageBuffers?: number | undefined;
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
  const nativeFirst = pref === "native" || (pref === "auto" && (!env.webgpu || env.native.path === "rayquery"));
  const order: TracerKind[] = nativeFirst ? ["native", "webgpu"] : ["webgpu", "native"];
  const left = order.filter(usable);
  if (left.every((k) => env.faulted?.has(k)) && left.length > 1) return null;
  return left.find((k) => !env.faulted?.has(k)) ?? left[0] ?? null;
}

/** The native probe takes 350 to 610 ms, WebGPU's far less, so a trace started at boot would otherwise
 *  read "checking" as no native tracer and keep WebGPU for the whole session. */
export function waitsForNative(pref: TracerPref, webgpu: boolean, native: NativeProbe | null): boolean {
  return !native && !(pref === "webgpu" && webgpu);
}

/** `prefer` "websocket" skips the native shared buffers. `call` stands in for
 *  Tauri's invoke, the dev tracer server's socket outside the app. */
export async function createTracerOf(kind: TracerKind, prefer?: string, call?: Call): Promise<TracerBackend> {
  if (kind === "native") {
    const { connectNative, createNativeTracer } = await import("./nativeTracer");
    if (!call) return createNativeTracer({ prefer });
    return createNativeTracer({ prefer, call, connect: (w, h, p) => connectNative(w, h, p, call) });
  }
  return (await import("./webgpuTracer")).createWebGpuTracer();
}
