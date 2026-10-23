// Committing a refused preview adds a history entry that fails on the next rebuild. "wait" commits at once and
// leaves DocumentStore.verifyCommit to undo the commit if the rebuild refuses it.

export interface PreviewState {
  hasPreview: boolean;
  previewError: string | null;
  buildState: { building: boolean };
}

export type PreviewVerdict = { kind: "commit" } | { kind: "wait" } | { kind: "refused"; reason: string };

export function previewVerdict(store: PreviewState): PreviewVerdict {
  if (!store.hasPreview) return { kind: "commit" };
  if (store.buildState.building) return { kind: "wait" };
  const reason = store.previewError;
  return reason ? { kind: "refused", reason } : { kind: "commit" };
}
