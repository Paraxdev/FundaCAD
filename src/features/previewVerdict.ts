// Committing a refused preview adds a history entry that fails on the next rebuild. "wait" commits at once and
// leaves DocumentStore.verifyCommit to undo the commit if the rebuild refuses it.

import { shownLine } from "../ui/englishLines";

export interface PreviewState {
  hasPreview: boolean;
  previewError: string | null;
  buildState: { building: boolean };
}

/** A refusal's `reason` is as the tool shows it. */
export type PreviewVerdict = { kind: "commit" } | { kind: "wait" } | { kind: "refused"; reason: string };

export function previewVerdict(store: PreviewState): PreviewVerdict {
  if (!store.hasPreview) return { kind: "commit" };
  if (store.buildState.building) return { kind: "wait" };
  const reason = store.previewError;
  return reason ? { kind: "refused", reason: shownLine(reason) } : { kind: "commit" };
}
