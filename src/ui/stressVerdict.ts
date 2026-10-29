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

/** Where the engine's own warning puts the peak, from its wording. */
export function peakPlaceOf(warnings: readonly string[]): PeakPlace {
  for (const w of warnings) {
    if (w.startsWith("the peak stress is at a sharp inside corner")) return "corner";
    if (/^the peak stress is where a .* ends/.test(w)) return "support";
  }
  return null;
}

// The engine reads the peak at a sharp inside corner or a support's edge too high, and higher with a finer mesh.
export type PeakPlace = "corner" | "support" | null;

const SPOT: Record<"corner" | "support" | "plain", [marked: string, unmarked: string | null]> = {
  corner: ["at the marked sharp corner", "at a sharp inside corner"],
  support: ["at the marked edge of a support", "at the edge of a support"],
  plain: ["at the marked spot", null],
};

const ROUGH: Record<"corner" | "support", string> = {
  corner: "The number at a sharp corner is rough, and rounding the corner makes it stronger.",
  support: "The number there is rough, so read the colour a little away from it.",
};

/** The overload of a factor below 1: under 2x in whole percent, rounded up, otherwise as a factor. */
function overload(sf: number): { pct: number } | { factor: string } {
  const x = 1 / sf;
  if (x < 2) return { pct: Math.max(1, Math.ceil((x - 1) * 100 - 1e-9)) };
  return { factor: aboutFactor(x, "up") };
}

export interface VerdictInput {
  safetyFactor: number | null;
  peakPlace?: PeakPlace;
}

/** `marked` while the weakest spot's pin shows in the view. */
export function verdictView(r: VerdictInput, margin = SAFE_MARGIN, marked = true): StressVerdictView {
  const sf = r.safetyFactor;
  if (sf === null || Number.isNaN(sf)) {
    return { level: "none", headline: "Nothing is stressed, check the loads.", detail: null };
  }
  const place = r.peakPlace ?? null;
  const spot = SPOT[place ?? "plain"][marked ? 0 : 1];
  const rough = place ? ROUGH[place] : null;
  if (sf < 1) {
    const o = overload(sf);
    const load =
      "pct" in o
        ? `The load is about ${o.pct}% more than it can take.`
        : o.factor.startsWith("more")
          ? "The load is more than 100x what it can take."
          : `The load is about ${o.factor}x what it can take.`;
    return {
      level: "fails",
      headline: `Likely to fail${spot ? ` ${spot}` : ""}${rough ? ", by a rough reading" : ""}.`,
      detail: rough ? `${load} ${rough}` : load,
    };
  }
  const safe = aboutFactor(sf, "down");
  // Rounded down, so "at least": a 4.57 in the table reads 4.5 here.
  const about = safe.startsWith("more") ? safe : `at least ${safe}`;
  const holds = rough ? "Holds by a rough reading," : "Holds,";
  const weakest = spot ? `Weakest ${spot}.` : null;
  const detail = [weakest, rough].filter(Boolean).join(" ") || null;
  if (sf < margin) {
    return { level: "marginal", headline: `${holds} ${about}x safe, but keep about ${margin}x.`, detail };
  }
  return { level: "holds", headline: `${holds} ${about}x safe.`, detail };
}

/** The weakest spot's pin label, in the verdict's numbers. */
export function weakSpotLabel(sf: number | null): string {
  if (sf === null || !Number.isFinite(sf)) return "Weakest";
  if (sf >= 1) {
    const safe = aboutFactor(sf, "down");
    return `Weakest, ${safe.startsWith("more") ? safe : `at least ${safe}`}x safe`;
  }
  const o = overload(sf);
  return "pct" in o ? `Weakest, ${o.pct}% over` : `Weakest, ${o.factor}x over`;
}

/** How far the part bends and how it is drawn at the slider's `scale`; null without a deflection. */
export function deflectionNote(maxDeflectionMm: number | null, unit: Unit, scale: number): string | null {
  if (maxDeflectionMm === null || !Number.isFinite(maxDeflectionMm)) return null;
  const drawn = scale === 0 ? "not drawn" : scale === 1 ? "drawn at true size" : `drawn ${deformLabel(scale)} larger`;
  return `Bends at most ${displayRound(toDisplay(maxDeflectionMm))} ${unit}, ${drawn}.`;
}
