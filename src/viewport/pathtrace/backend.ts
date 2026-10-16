// The seam a tracer plugs into. P1 ships the WebGPU tracer behind it; a native
// tracer that streams frames from the engine can take its place without the
// viewport noticing.

import type * as THREE from "three";

export interface TraceLight {
  color: THREE.Color;
  intensity: number;
  /** World position of the light; it shines at `target`. */
  position: THREE.Vector3;
  target: THREE.Vector3;
}

export interface TraceScene {
  meshes: THREE.Mesh[];
  lights: TraceLight[];
  background: THREE.Color;
  brightness: number;
  toneMapping: THREE.ToneMapping;
  exposure: number;
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
  /** Re-reads the camera, which also restarts accumulation. */
  updateCamera(camera: THREE.Camera): void;
  reset(): void;
  renderSample(): void;
  /** Samples gathered per pixel since the last reset. */
  samples(): Promise<number>;
  dispose(): void;
  /** A GPU error or a lost device; the viewport drops to Realtime. */
  onFault(cb: (why: string) => void): void;
}

export const SAMPLE_CAP = 256;
