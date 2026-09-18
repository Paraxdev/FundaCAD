// Whether a release may commit, judged by the kernel's answer on the live preview.
//
// A tool that previews through the sidecar knows before committing whether the
// feature builds. Committing a refused one adds a history entry that fails on the
// next rebuild, which reads as the release having broken the model.
//
// "wait" means the kernel has not answered yet. A tool never waits for it: it
// commits at once and hands the verdict to DocumentStore.verifyCommit, which
// undoes the commit if the rebuild refuses it.

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
