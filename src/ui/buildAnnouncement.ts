// What a settled rebuild says to a screen reader, kept apart from app/announcements.ts so a test reaches it.

import type { RebuildState } from "../document/store";
import type { AnnouncePriority } from "./announce";
import { namesStep, plainError } from "./plainError";

export interface BuildLine {
  text: string;
  priority: AnnouncePriority;
}

type Settled = Pick<RebuildState, "building" | "errorFeatureId" | "errorMessage" | "cancelled" | "previewBuilt"> & {
  result: { bodies?: readonly unknown[] } | null;
};

/** The announcer key of a step's failure, shared by the build line and the step's error notice so it is said once. */
export const failureKey = (featureId: string) => `failed:${featureId}`;

const failureOf = (s: Settled) => (s.errorFeatureId || s.errorMessage ? `${s.errorFeatureId}|${s.errorMessage}` : null);

/** Null while building and for a tool's live preview, which the tool's own prompt reports. A failure is assertive the
 *  first time; one that is still there after the next edit is said politely, so every edit does not interrupt. */
export function buildLine(
  now: Settled,
  lastSettled: Settled | null,
  nameOf: (featureId: string) => string | null,
): BuildLine | null {
  if (now.building || now.previewBuilt) return null;
  if (now.cancelled) return { text: "Build cancelled", priority: "polite" };
  const n = now.result?.bodies?.length ?? 0;
  const built = n ? `Built, ${n} ${n === 1 ? "body" : "bodies"}` : "Built";
  const failure = failureOf(now);
  if (!failure) return { text: built, priority: "polite" };
  const at = now.errorFeatureId ? nameOf(now.errorFeatureId) : null;
  if (lastSettled && failureOf(lastSettled) === failure) {
    return { text: `${built}, ${at ?? "a feature"} still fails`, priority: "polite" };
  }
  const why = plainError(now.errorMessage ?? "", "");
  const word = at ? namesStep(at, why) : 0;
  // "Fillet: <why>" drops its label for the step's own name, "Fillet failed on Box" already names the step.
  if (word && why[word] === ":")
    return { text: `Build failed at ${at}: ${why.slice(word + 1).trim()}`, priority: "assertive" };
  if (word) return { text: `Build failed: ${why}`, priority: "assertive" };
  return { text: `Build failed${at ? ` at ${at}` : ""}${why ? `: ${why}` : ""}`, priority: "assertive" };
}
