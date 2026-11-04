// The kernel can hand back a body with no faces, as it does for a sketch 1e8 mm out: nothing draws, so the step that
// made it has failed even though the engine reported no error.
import type { CadDocument, RebuildResult } from "../types";

export const FACELESS_BODY =
  "The body came out with no faces, so there is nothing to show. Move the sketch within 1 km of the origin";

type FeatureError = NonNullable<RebuildResult["featureErrors"]>[number];

/** The latest step in the timeline the id map credits with the body, the one whose result was empty. */
function makerOf(bodyId: string, doc: Pick<CadDocument, "features" | "bodyIds">): string | null {
  const order = new Map(doc.features.map((f, i) => [f.id, i]));
  let best: { id: string; at: number } | null = null;
  for (const [key, id] of Object.entries(doc.bodyIds ?? {})) {
    if (id !== bodyId) continue;
    const feature = key.slice(0, key.lastIndexOf(":"));
    const at = order.get(feature) ?? -1;
    if (feature && (!best || at > best.at)) best = { id: feature, at };
  }
  return best?.id ?? null;
}

export function withFacelessFailures(
  result: RebuildResult,
  doc: Pick<CadDocument, "features" | "bodyIds">,
): RebuildResult {
  const empty = (result.bodies ?? []).filter((b) => b.faceCount === 0);
  if (!empty.length) return result;
  const failed = new Set((result.featureErrors ?? []).map((e) => e.feature_id ?? null));
  const added: FeatureError[] = [];
  for (const b of empty) {
    const maker = makerOf(b.id, doc);
    if (failed.has(maker)) continue;
    failed.add(maker);
    added.push(maker ? { feature_id: maker, message: FACELESS_BODY } : { message: FACELESS_BODY });
  }
  if (!added.length) return result;
  return {
    ...result,
    featureErrors: [...(result.featureErrors ?? []), ...added],
    featureError: result.featureError ?? added[added.length - 1]!,
  };
}
