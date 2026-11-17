// The engine words why a body has no inside to follow the body's name (crates/fundacad-geom/src/soundness.rs, fault()
// and material()). These match each form it sends, so the whole sentence reads in the chosen language.

import { t, type MessageKey } from "../i18n";

const FORMS: readonly [RegExp, MessageKey][] = [
  [/^is a surface, not a solid, so it has no inside$/, "soundness.surface"],
  [/^is not a closed solid, (\d+) of its edges (?:bounds|bound) only one face, so it has no inside$/, "soundness.open"],
  [
    /^is not one clean solid, (\d+) of its edges (?:is|are) shared by more than two faces, so it has no single inside$/,
    "soundness.crowded",
  ],
  [
    /^has faces that point the wrong way, at (\d+) of its edges the two faces disagree about which side is inside$/,
    "soundness.flipped",
  ],
  [/^is inside out, its faces point into the material, and it could not be turned over$/, "soundness.insideOutStuck"],
  [/^is inside out, its faces point into the material$/, "soundness.insideOut"],
];

/** The translated sentence for a reason the engine sends, or null for one it does not know. */
export function knownBodyReason(body: string, reason: string): string | null {
  for (const [form, key] of FORMS) {
    const m = form.exec(reason);
    if (m) return t(key, { body, n: m[1] === undefined ? 0 : Number(m[1]) });
  }
  return null;
}

/** "Rod is not a closed solid, ...", an unknown reason as the engine wrote it after the name. */
export function bodyReason(body: string, reason: string): string {
  return knownBodyReason(body, reason) ?? `${body} ${reason}`;
}
