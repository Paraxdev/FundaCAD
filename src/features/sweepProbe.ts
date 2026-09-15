// Points that stand for the volume a profile sweeps, so a tool can ask which
// bodies its preview passes into without building the solid.

import * as THREE from "three";

export interface SweepProfile {
  /** A point inside the profile's material, on its plane. */
  interior: THREE.Vector3;
  /** The outer outline, on the plane. */
  loop: readonly THREE.Vector3[];
  /** Unit plane normal. */
  normal: THREE.Vector3;
}

/** Kept off the plane and off the outline, where a parity count grazes a face. */
const SKIN = 0.05;
const LOOP_SAMPLES = 8;

/** The interior and a spread of outline points, each at the near end, middle
 *  and far end of the sweep, both ways when `symmetric`. `distance` is signed
 *  along the normal, as the extrude stores it. */
export function sweepProbePoints(
  profiles: readonly SweepProfile[],
  distance: number,
  symmetric: boolean,
): THREE.Vector3[] {
  const depth = Math.abs(distance);
  if (depth < 1e-6) return [];
  const sign = distance >= 0 ? 1 : -1;
  const depths = depth <= SKIN * 4 ? [depth / 2] : [SKIN, depth / 2, depth - SKIN];
  const sides = symmetric ? [sign, -sign] : [sign];
  const out: THREE.Vector3[] = [];
  for (const p of profiles) {
    const bases = [p.interior];
    const step = Math.max(1, Math.floor(p.loop.length / LOOP_SAMPLES));
    for (let i = 0; i < p.loop.length && bases.length <= LOOP_SAMPLES; i += step) {
      const v = p.loop[i]!;
      const inward = p.interior.clone().sub(v);
      const len = inward.length();
      if (len <= SKIN * 2) continue;
      bases.push(v.clone().addScaledVector(inward, SKIN / len));
    }
    for (const b of bases) {
      for (const s of sides) {
        for (const d of depths) out.push(b.clone().addScaledVector(p.normal, s * d));
      }
    }
  }
  return out;
}
