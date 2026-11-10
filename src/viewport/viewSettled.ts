export interface SettleRig {
  isFlying(): boolean;
  poseVersion(): number;
}

/** Runs `then` once the view has settled: no flight, and the pose still for one `pause`. The classic rig turns to a
 *  named view by its controls' own transition, which `isFlying` does not report. Returns what cancels the wait. */
export function whenViewSettles(rig: SettleRig, pause: number, then: () => void): () => void {
  let seen = rig.poseVersion();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = () => {
    const now = rig.poseVersion();
    if (rig.isFlying() || now !== seen) {
      seen = now;
      timer = setTimeout(check, pause);
      return;
    }
    timer = null;
    then();
  };
  timer = setTimeout(check, pause);
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
