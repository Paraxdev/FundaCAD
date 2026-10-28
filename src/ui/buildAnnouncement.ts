// What a settled rebuild says to a screen reader, kept apart from app/announcements.ts so a test reaches it.

import type { RebuildState } from "../document/store";
import type { AnnouncePriority } from "./announce";

export interface BuildLine {
  text: string;
  priority: AnnouncePriority;
}

type Settled = Pick<RebuildState, "building" | "errorFeatureId" | "errorMessage" | "cancelled" | "previewBuilt"> & {
  result: { bodies?: readonly unknown[] } | null;
};

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
  const why = now.errorMessage?.trim();
  return { text: `Build failed${at ? ` at ${at}` : ""}${why ? `: ${why}` : ""}`, priority: "assertive" };
}
