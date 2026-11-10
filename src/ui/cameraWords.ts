// What a camera step says once the view settles: where the model is seen from, absolute, so the words do not depend on
// which way the arrow keys carry the view. One message per shape, so each language orders the words its own way.

import { t } from "../i18n";
import { standardViewOf } from "./viewSummary";

type Side = "front" | "right" | "back" | "left";

// Counterclockwise seen from above, the order the azimuth below counts in.
const SIDES: readonly Side[] = ["front", "right", "back", "left"];

const deg = (rad: number) => (rad * 180) / Math.PI;
const sideAt = (i: number) => SIDES[((i % 4) + 4) % 4]!;

/** `eye` points from the target to the camera, Z up, front at -Y. */
export function cameraWords(eye: readonly [number, number, number], ortho: boolean): string {
  const projection = ortho ? "ortho" : "persp";
  const view = standardViewOf(eye);
  if (view) return t("camera.standard", { view, projection });
  const [x, y, z] = eye;
  const len = Math.hypot(x, y, z);
  const azimuth = deg(Math.atan2(x, -y));
  const index = Math.round(azimuth / 90);
  const off = Math.round(azimuth - index * 90);
  const tilt = Math.round(deg(Math.asin(len > 0 ? z / len : 0)));
  const args = {
    side: sideAt(index),
    toward: sideAt(index + Math.sign(off)),
    turn: Math.abs(off),
    tilt: Math.abs(tilt),
    from: tilt > 0 ? "above" : "below",
    projection,
  };
  // Both zero is within a degree of a side, which standardViewOf already took.
  if (off === 0) return t("camera.tilted", args);
  return t(tilt === 0 ? "camera.turned" : "camera.turnedTilted", args);
}
