// What a settled rebuild says to a screen reader, kept apart from app/announcements.ts so a test reaches it.

import type { RebuildState } from "../document/store";
import { t } from "../i18n";
import type { AnnouncePriority } from "./announce";
import { namesStep, plainError } from "./plainError";

export interface BuildLine {
  text: string;
  priority: AnnouncePriority;
}

type Settled = Pick<RebuildState, "building" | "errorFeatureId" | "errorMessage" | "cancelled" | "previewBuilt"> & {
  result: { bodies?: readonly { faceCount?: number }[] } | null;
};

/** The announcer key of a step's failure, shared by the build line and the step's error notice so it is said once. */
export const failureKey = (featureId: string) => `failed:${featureId}`;

const failureOf = (s: Settled) => (s.errorFeatureId || s.errorMessage ? `${s.errorFeatureId}|${s.errorMessage}` : null);

/** Null while building and for a tool's live preview, which the tool's own prompt reports. A failure is assertive the
 *  first time; one that is still there after the next edit is said politely, so every edit does not interrupt.
 *  `nameOf` is the step as said, `englishOf` the name the engine's English sentence may start with. */
export function buildLine(
  now: Settled,
  lastSettled: Settled | null,
  nameOf: (featureId: string) => string | null,
  englishOf: (featureId: string) => string | null = nameOf,
): BuildLine | null {
  if (now.building || now.previewBuilt) return null;
  if (now.cancelled) return { text: t("buildSaid.cancelled"), priority: "polite" };
  // A body with no faces is a failure the store reports, not a built body.
  const n = now.result?.bodies?.filter((b) => b.faceCount !== 0).length ?? 0;
  const built = t("buildSaid.built", { n });
  const failure = failureOf(now);
  if (!failure) return { text: built, priority: "polite" };
  const at = now.errorFeatureId ? nameOf(now.errorFeatureId) : null;
  if (lastSettled && failureOf(lastSettled) === failure) {
    return { text: t("buildSaid.stillFails", { built, named: at ? "yes" : "no", at: at ?? "" }), priority: "polite" };
  }
  const why = plainError(now.errorMessage ?? "", "");
  const english = now.errorFeatureId ? englishOf(now.errorFeatureId) : null;
  const word = at && english ? namesStep(english, why) : 0;
  // "Fillet: <why>" drops its label for the step's own name, "Fillet failed on Box" already names the step.
  if (word && why[word] === ":")
    return { text: t("buildSaid.failedAt", { at: at!, why: why.slice(word + 1).trim() }), priority: "assertive" };
  if (word) return { text: t("buildSaid.failed", { why }), priority: "assertive" };
  if (at) {
    const text = why ? t("buildSaid.failedAt", { at, why }) : t("buildSaid.failedAtNoWhy", { at });
    return { text, priority: "assertive" };
  }
  return { text: why ? t("buildSaid.failed", { why }) : t("buildSaid.failedNoWhy"), priority: "assertive" };
}
