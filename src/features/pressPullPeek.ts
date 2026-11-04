import type { Feature, PressPullMode } from "../types";

/** A Cut previews its tool body inside the body it cuts, so that body is seen through. Only Cut: a Join pushed
 *  inward is refused, and the ghost it kept read as the whole body gone translucent. */
export function peeksThrough(f: Feature | null, mode: PressPullMode): boolean {
  return mode === "cut" && f?.type === "press-pull" && f.operation === "cut";
}
