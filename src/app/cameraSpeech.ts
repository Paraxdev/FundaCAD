import type * as THREE from "three";
import { announce } from "../ui/announce";
import { cameraWords } from "../ui/cameraWords";

/** The pause before a camera step speaks, so a held arrow key says only where it stopped. */
export const CAMERA_SPEECH_DELAY = 250;

export interface CameraHost {
  viewDirection(): THREE.Vector3;
  rig: { isOrtho(): boolean; isFlying(): boolean; poseVersion(): number };
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Says where the model is seen from once the view has settled: no flight, and the pose still for one pause.
 *  The classic rig turns to a named view by its controls' own transition, which `isFlying` does not report. */
export function speakCameraWhenSettled(view: CameraHost): void {
  if (timer) clearTimeout(timer);
  let seen = view.rig.poseVersion();
  const settled = () => {
    const now = view.rig.poseVersion();
    if (view.rig.isFlying() || now !== seen) {
      seen = now;
      timer = setTimeout(settled, CAMERA_SPEECH_DELAY);
      return;
    }
    timer = null;
    const look = view.viewDirection();
    announce(cameraWords([-look.x, -look.y, -look.z], view.rig.isOrtho()), "polite", { key: "camera" });
  };
  timer = setTimeout(settled, CAMERA_SPEECH_DELAY);
}
