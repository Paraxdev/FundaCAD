// The seam a tracer plugs into. P1 ships the WebGPU tracer behind it; a native
// tracer that streams frames from the engine can take its place without the
// viewport noticing.

import type * as THREE from "three";
import type { Denoise } from "../../ui/renderPrefs";
import type { TraceLens } from "./camera";

export interface TraceLight {
  color: THREE.Color;
  intensity: number;
  /** World position of the light; it shines at `target`. */
  position: THREE.Vector3;
  target: THREE.Vector3;
}

export interface TraceLook {
  lights: TraceLight[];
  /** Linear, before tone mapping: the tracer tone maps its background, the
   *  Realtime clear is not, so this is the clear run back through the tone mapper. */
  background: THREE.Color;
  /** An equirect, sampled as it is (no rotation), like the Realtime cube. */
  environment: THREE.Texture;
  brightness: number;
  toneMapping: THREE.ToneMapping;
  exposure: number;
}

export interface TraceScene extends TraceLook {
  meshes: THREE.Mesh[];
  lens: TraceLens | null;
}

export interface TracerBackend {
  /** Drawn under the viewport's own canvas. */
  readonly canvas: HTMLCanvasElement;
  readonly name: string;
  init(): Promise<void>;
  setSize(cssWidth: number, cssHeight: number, pixelRatio: number): void;
  /** The first scene; every later change goes through the update calls. The
   *  meshes carry their tree on geometry.boundsTree and stay owned by the caller. */
  setScene(scene: TraceScene, camera: THREE.Camera): void;
  /** A new set of meshes, or new vertex colours on the same ones: repacks the
   *  buffers from the cached trees, no tree is built. */
  updateGeometry(meshes: THREE.Mesh[]): void;
  /** Re-reads the meshes' matrices and refits the top level tree. */
  updateTransforms(): void;
  updateMaterials(): void;
  /** New lights, background, environment or exposure; restarts accumulation. */
  updateLook(look: TraceLook): void;
  /** The largest storage buffer the device took, for the size refusal. */
  readonly maxStorageBytes: number;
  /** Re-reads the camera, which also restarts accumulation. A lens is depth of
   *  field, null a pinhole. */
  updateCamera(camera: THREE.Camera, lens: TraceLens | null): void;
  reset(): void;
  /** Gathers one more frame of samples; `samples` is the count so far, which
   *  sets how hard the image is filtered on its way to the screen. Resolves
   *  with the frame's GPU time in ms once the GPU has finished it. */
  renderSample(samples: number): Promise<number>;
  /** Path slots traced per frame. */
  setFrameBudget(slots: number): void;
  /** The trace's size against the canvas drawing buffer, 1 at full size. */
  setRenderScale(scale: number): void;
  /** Samples per pixel where tracing stops. */
  setCap(samples: number): void;
  /** At the cap: runs the final denoise and crossfades to it. False once
   *  nothing is left to draw, so the GPU can idle. */
  present(now: number): boolean;
  /** The image on screen is the denoised one. */
  readonly denoised: boolean;
  /** Swaps the denoise weights; the samples gathered are kept. */
  setDenoise(level: Denoise): void;
  /** Samples gathered per pixel since the last reset. */
  samples(): Promise<number>;
  dispose(): void;
  /** A GPU error or a lost device; the viewport drops to Realtime. */
  onFault(cb: (why: string) => void): void;
}

export const SAMPLE_CAP = 256;
