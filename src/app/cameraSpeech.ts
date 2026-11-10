import type * as THREE from "three";
import { announce } from "../ui/announce";
import { cameraWords } from "../ui/cameraWords";

/** The pause before a camera step speaks, so a held arrow key says only where it stopped. */
export const CAMERA_SPEECH_DELAY = 250;

export interface CameraHost {
  viewDirection(): THREE.Vector3;
  rig: { isOrtho(): boolean; isFlying(): boolean };
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Says where the model is seen from once the view has settled, a flight is waited out. */
export function speakCameraWhenSettled(view: CameraHost): void {
  if (timer) clearTimeout(timer);
  const settled = () => {
    if (view.rig.isFlying()) {
      timer = setTimeout(settled, CAMERA_SPEECH_DELAY);
      return;
    }
    timer = null;
    const look = view.viewDirection();
    announce(cameraWords([-look.x, -look.y, -look.z], view.rig.isOrtho()), "polite", { key: "camera" });
  };
  timer = setTimeout(settled, CAMERA_SPEECH_DELAY);
}
