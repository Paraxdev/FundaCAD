// The kernel can hand back a body with no faces, as it does for a sketch 1e8 mm out: nothing draws, so the step that
// made it has failed even though the engine reported no error.
import { within } from "../sketch/pointEntry";
import type { CadDocument, CoreFeature, RebuildResult } from "../types";

export const FACELESS_BODY = "The body came out with no faces, so there is nothing to show.";
export const FAR_SKETCH_HINT = "Move the sketch within 1 km of the origin.";

type Doc = Pick<CadDocument, "features" | "bodyIds" | "parameters">;
type FeatureError = NonNullable<RebuildResult["featureErrors"]>[number];
type Point = { x?: unknown; y?: unknown };
type Sketch = Extract<CoreFeature, { type: "sketch" }>;

const COORDS = ["x", "y", "x1", "y1", "x2", "y2", "mx", "my"] as const;

/** The latest step in the timeline the id map credits with the body, the one whose result was empty. */
function makerOf(bodyId: string, doc: Doc): string | null {
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

/** Only a sketch past the limit a typed point has is known to give an empty body, so only then is the hint true. */
function sketchTooFar(makerId: string | null, doc: Doc): boolean {
  const maker = doc.features.find((f) => f.id === makerId);
  const ref = (maker as { sketch?: unknown } | undefined)?.sketch;
  const found = maker?.type === "sketch" ? maker : doc.features.find((f) => f.id === ref);
  if (found?.type !== "sketch") return false;
  const sketch = found as Sketch;
  const far = (v: unknown) => {
    const n = typeof v === "number" ? v : typeof v === "string" ? doc.parameters?.[v] : undefined;
    return n !== undefined && !within(n);
  };
  // An agent's document may leave any of these out.
  if (typeof sketch.plane === "object" && sketch.plane?.origin?.some(far)) return true;
  if (sketch.at?.some(far)) return true;
  return (sketch.entities ?? []).some((e) => {
    const r = e as Record<string, unknown>;
    const pts = [...((r.points as Point[] | undefined) ?? []), ...((r.poles as Point[] | undefined) ?? [])];
    return COORDS.some((k) => far(r[k])) || pts.some((p) => far(p.x) || far(p.y));
  });
}

export function withFacelessFailures(result: RebuildResult, doc: Doc): RebuildResult {
  const empty = (result.bodies ?? []).filter((b) => b.faceCount === 0);
  if (!empty.length) return result;
  const failed = new Set((result.featureErrors ?? []).map((e) => e.feature_id ?? null));
  const added: FeatureError[] = [];
  for (const b of empty) {
    const maker = makerOf(b.id, doc);
    if (failed.has(maker)) continue;
    failed.add(maker);
    const message = sketchTooFar(maker, doc) ? `${FACELESS_BODY} ${FAR_SKETCH_HINT}` : FACELESS_BODY;
    added.push(maker ? { feature_id: maker, message } : { message });
  }
  if (!added.length) return result;
  return {
    ...result,
    featureErrors: [...(result.featureErrors ?? []), ...added],
    featureError: result.featureError ?? added[added.length - 1]!,
  };
}
