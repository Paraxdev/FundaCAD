// The seam a tracer plugs into. P1 ships the WebGPU tracer behind it; a native
// tracer that streams frames from the engine can take its place without the
// viewport noticing.

import type * as THREE from "three";
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
  renderSample(): void;
  /** Samples gathered per pixel since the last reset. */
  samples(): Promise<number>;
  dispose(): void;
  /** A GPU error or a lost device; the viewport drops to Realtime. */
  onFault(cb: (why: string) => void): void;
}

export const SAMPLE_CAP = 256;
