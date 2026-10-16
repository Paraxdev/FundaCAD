declare module "three-gpu-pathtracer/webgpu" {
  import type { Camera, Scene } from "three";
  export class WebGPUPathTracer {
    constructor(renderer: unknown);
    maxSamples: number;
    maxBounces: number;
    renderDelay: number;
    minSamples: number;
    fadeDuration: number;
    renderScale: number;
    synchronizeRenderSize: boolean;
    setScene(scene: Scene, camera: Camera): void;
    setCamera(camera: Camera): void;
    updateCamera(): void;
    updateMaterials(): void;
    updateTransforms(): void;
    updateEnvironment(): void;
    updateLights(): void;
    reset(): void;
    renderSample(): void;
    getSampleCountsAsync(): Promise<{ min: number; max: number; avg: number }>;
    dispose(): void;
  }
}

declare module "three-gpu-pathtracer/src/objects/PhysicalCamera.js" {
  import { PerspectiveCamera } from "three";
  export class PhysicalCamera extends PerspectiveCamera {
    fStop: number;
    bokehSize: number;
    apertureBlades: number;
    apertureRotation: number;
    focusDistance: number;
    anamorphicRatio: number;
  }
}
