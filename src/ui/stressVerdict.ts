// The plain words a stress result opens with, from the engine's safety factor and deflection.

import { deformLabel } from "./stress";
import { displayRound, toDisplay, type Unit } from "./units";

export type VerdictLevel = "holds" | "marginal" | "fails" | "none";

export interface StressVerdictView {
  level: VerdictLevel;
  headline: string;
  detail: string | null;
}

// A printed or moulded part is kept at about 1.5 times what it takes before it counts as safe.
export const SAFE_MARGIN = 1.5;

/** `x` to two significant figures, rounded down for a safety margin so it is never overstated, up for an overload
 *  so it is never understated. */
export function aboutFactor(x: number, round: "down" | "up"): string {
  if (!Number.isFinite(x) || x > 100) return "more than 100";
  if (x <= 0) return "0";
  const step = 10 ** (Math.floor(Math.log10(x)) - 1);
  // The nudge keeps 9.9 / 0.1 = 98.99999 from rounding a whole step the wrong way.
  const n = round === "down" ? Math.floor(x / step + 1e-9) : Math.ceil(x / step - 1e-9);
  return String(Number((n * step).toPrecision(12)));
}

export function verdictView(r: { safetyFactor: number | null }, margin = SAFE_MARGIN): StressVerdictView {
  const sf = r.safetyFactor;
  if (sf === null || Number.isNaN(sf)) {
    return { level: "none", headline: "Nothing is stressed, check the loads.", detail: null };
  }
  if (sf < 1) {
    return {
      level: "fails",
      headline: "Likely to fail at the marked spot.",
      detail: `The load is about ${aboutFactor(1 / sf, "up")}x what it can take.`,
    };
  }
  const safe = aboutFactor(sf, "down");
  const about = safe.startsWith("more") ? safe : `about ${safe}`;
  if (sf < margin) {
    return {
      level: "marginal",
      headline: `Holds, but only ${about}x safe, keep about ${margin}x.`,
      detail: "Weakest at the marked spot.",
    };
  }
  return { level: "holds", headline: `Holds, ${about}x safe.`, detail: "Weakest at the marked spot." };
}

/** How far the part bends and how it is drawn at the slider's `scale`; null without a deflection. */
export function deflectionNote(maxDeflectionMm: number | null, unit: Unit, scale: number): string | null {
  if (maxDeflectionMm === null || !Number.isFinite(maxDeflectionMm)) return null;
  const drawn = scale === 0 ? "not drawn" : scale === 1 ? "drawn at true size" : `drawn ${deformLabel(scale)} larger`;
  return `Bends at most ${displayRound(toDisplay(maxDeflectionMm))} ${unit}, ${drawn}.`;
}
