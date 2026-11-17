// The plain words a stress result opens with, from the engine's safety factor and deflection.

import { t } from "../i18n";
import { deformScale } from "./stress";
import { spellNumber, spellRounded } from "./measure";
import { toDisplay, type Unit } from "./units";

export type VerdictLevel = "holds" | "marginal" | "fails" | "none";

export interface StressVerdictView {
  level: VerdictLevel;
  headline: string;
  detail: string | null;
}

// A printed or moulded part is kept at about 1.5 times what it takes before it counts as safe.
export const SAFE_MARGIN = 1.5;

const isBeyondCap = (x: number) => !Number.isFinite(x) || x > 100;

/** `x` to two significant figures, rounded down for a safety margin so it is never overstated, up for an overload
 *  so it is never understated. */
export function aboutFactor(x: number, round: "down" | "up"): string {
  if (isBeyondCap(x)) return t("stress.verdict.moreThan100");
  if (x <= 0) return "0";
  const step = 10 ** (Math.floor(Math.log10(x)) - 1);
  // The nudge keeps 9.9 / 0.1 = 98.99999 from rounding a whole step the wrong way.
  const n = round === "down" ? Math.floor(x / step + 1e-9) : Math.ceil(x / step - 1e-9);
  return spellNumber(Number((n * step).toPrecision(12)));
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

const yesNo = (on: boolean) => (on ? "yes" : "no");

/** `marked` while the weakest spot's pin shows in the view. */
export function verdictView(r: VerdictInput, margin = SAFE_MARGIN, marked = true): StressVerdictView {
  const sf = r.safetyFactor;
  if (sf === null || Number.isNaN(sf)) return { level: "none", headline: t("stress.verdict.none"), detail: null };
  const place = r.peakPlace ?? "plain";
  const at = { place, marked: yesNo(marked) };
  if (sf < 1) {
    const o = overload(sf);
    const over =
      "pct" in o
        ? { over: "pct", pct: o.pct }
        : isBeyondCap(1 / sf)
          ? { over: "more" }
          : { over: "factor", factor: o.factor };
    return {
      level: "fails",
      headline: t("stress.verdict.failHead", at),
      detail: t("stress.verdict.failDetail", { ...over, place }),
    };
  }
  // Rounded down, so "at least": a 4.57 in the table reads 4.5 here.
  const held = {
    place,
    over: isBeyondCap(sf) ? "more" : "other",
    safe: aboutFactor(sf, "down"),
    keep: yesNo(sf < margin),
    margin: spellNumber(margin),
  };
  const detail = place === "plain" && !marked ? null : t("stress.verdict.holdDetail", at);
  return { level: sf < margin ? "marginal" : "holds", headline: t("stress.verdict.holdHead", held), detail };
}

/** The weakest spot's pin label, in the verdict's numbers. */
export function weakSpotLabel(sf: number | null): string {
  if (sf === null || !Number.isFinite(sf)) return t("stress.verdict.weakest", { kind: "none" });
  if (sf >= 1) {
    return t("stress.verdict.weakest", {
      kind: "safe",
      over: isBeyondCap(sf) ? "more" : "other",
      safe: aboutFactor(sf, "down"),
    });
  }
  const o = overload(sf);
  if ("pct" in o) return t("stress.verdict.weakest", { kind: "pct", pct: o.pct });
  return t("stress.verdict.weakest", {
    kind: "factor",
    over: isBeyondCap(1 / sf) ? "more" : "other",
    factor: o.factor,
  });
}

/** How far the part bends and how it is drawn at the slider's `scale`; null without a deflection. */
export function deflectionNote(maxDeflectionMm: number | null, unit: Unit, scale: number): string | null {
  if (maxDeflectionMm === null || !Number.isFinite(maxDeflectionMm)) return null;
  const shown = deformScale(scale);
  const drawn = scale === 0 ? "none" : shown === "1" ? "true" : scale < 1 ? "smaller" : "other";
  return t("stress.verdict.bends", { amount: spellRounded(toDisplay(maxDeflectionMm)), unit, drawn, scale: shown });
}
