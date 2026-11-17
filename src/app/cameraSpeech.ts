import type * as THREE from "three";
import { announce } from "../ui/announce";
import { cameraWords } from "../ui/cameraWords";
import { whenViewSettles, type SettleRig } from "../viewport/viewSettled";

/** The pause before a camera step speaks, so a held arrow key says only where it stopped. */
export const CAMERA_SPEECH_DELAY = 250;

export interface CameraHost {
  viewDirection(): THREE.Vector3;
  rig: SettleRig & { isOrtho(): boolean };
}

let cancel: (() => void) | null = null;

/** Says where the model is seen from once the view has settled. */
export function speakCameraWhenSettled(view: CameraHost): void {
  cancel?.();
  cancel = whenViewSettles(view.rig, CAMERA_SPEECH_DELAY, () => {
    const look = view.viewDirection();
    announce(cameraWords([-look.x, -look.y, -look.z], view.rig.isOrtho()), "polite", { key: "camera" });
  });
}
