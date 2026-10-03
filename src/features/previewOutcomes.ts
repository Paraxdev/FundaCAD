// What the kernel said about each preview a drag sent, shared by press/pull
// and offset face: which values built, which were refused and why, and which
// one the model on screen was built with, so a refused value holds the last
// one that built.

import type { RebuildState } from "../document/store";
import type { Feature } from "../types";
import type { BlendVerdict } from "./edgeDragMath";

/** A preview, everything but its id. */
export function featureKey(f: Feature): string {
  const rest: Record<string, unknown> = { ...f };
  delete rest.id;
  return JSON.stringify(rest);
}

function questionKey(f: Feature, dragged: readonly string[]): string {
  const rest: Record<string, unknown> = { ...f };
  for (const k of ["id", ...dragged]) delete rest[k];
  return JSON.stringify(rest);
}

export type BuildReply = Pick<RebuildState, "previewBuilt" | "heldRefusal" | "errorFeatureId" | "errorMessage">;

export class PreviewOutcomes {
  /** The preview the model on screen was built with, null when it shows none.
   *  setPreview's hold keeps it on screen through a refusal. */
  shownFeature: Feature | null = null;
  /** the refusal painted on the handle, the value box and the prompt */
  refusal: string | null = null;
  private refused = new Map<string, string>();
  private built = new Set<string>();

  /** `featureName` matches the feature name a kernel refusal leads with. */
  constructor(private readonly featureName: RegExp) {}

  /** Forget every answer. The refusal on screen stays until `refresh` decides. */
  forget() {
    this.shownFeature = null;
    this.refused = new Map();
    this.built = new Set();
  }

  clear() {
    this.forget();
    this.refusal = null;
  }

  /** Record what the kernel said about the preview it was SENT, which during
   *  a fast drag is often not the one on the handle any more. */
  note(s: BuildReply, previewId: string) {
    const sent = s.previewBuilt?.find((f) => f.id === previewId) ?? null;
    const held = s.heldRefusal?.featureId === previewId ? s.heldRefusal : null;
    if (!sent) this.shownFeature = null;
    else if (held) this.refused.set(featureKey(sent), held.message.replace(this.featureName, ""));
    else if (s.errorFeatureId != null || !s.errorMessage) {
      this.shownFeature = sent;
      this.built.add(featureKey(sent));
    }
  }

  isRefused(key: string): boolean {
    return this.refused.has(key);
  }

  verdict(key: string): BlendVerdict {
    return this.refused.has(key) ? "refused" : this.built.has(key) ? "builds" : "unknown";
  }

  /** The reply for this very preview has landed and is on screen. */
  settled(key: string): boolean {
    return this.shownFeature !== null && featureKey(this.shownFeature) === key;
  }

  /** The preview on screen when it differs from `current` only in the
   *  `dragged` fields, so a value held from earlier in the drag still counts. */
  shownFor(current: Feature, dragged: readonly string[]): Feature | null {
    const f = this.shownFeature;
    return f && questionKey(f, dragged) === questionKey(current, dragged) ? f : null;
  }

  /** Decide the refusal for the preview `key`, null when nothing is pushed.
   *  It stays up until a value builds, so the box does not flicker while the
   *  next answer is on its way. True when it changed. */
  refresh(key: string | null): boolean {
    const reason = key === null ? null : this.refused.get(key) ?? (this.built.has(key) ? null : this.refusal);
    if (reason === this.refusal) return false;
    this.refusal = reason;
    return true;
  }
}
