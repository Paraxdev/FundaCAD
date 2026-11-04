import type { CadDocument, Feature } from "../types";
import { numberedName } from "../ui/featureMeta";

export const STEP_LABEL = {
  edit: "Edit",
  bodyVisibility: "Body visibility",
  planeVisibility: "Plane visibility",
  bodyName: "Rename body",
  referenceImage: "Reference image",
  material: "Material",
  colour: "Colour",
  view: "View",
  restoreVersion: "Restore version",
  rollback: "Rollback",
  parameters: "Parameters",
  section: "Section view",
} as const;

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/** "Extrude 1" for one step, "3 steps" for several; names come from the list as given. */
export function deletedWhat(features: readonly Feature[], ids: readonly string[]): string {
  const gone = features.filter((f) => ids.includes(f.id));
  return gone.length === 1 ? numberedName(gone[0]!, features) : plural(gone.length, "step");
}

// Walks instead of stringifying, which copied an import's inline BREP twice per compare: 4 ms against 9 ms on 300 steps with 5 MB.
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function movedLabel(before: readonly Feature[], after: readonly Feature[]): string {
  const at = before.findIndex((f, i) => f.id !== after[i]!.id);
  const without = (list: readonly Feature[], id: string) => list.filter((f) => f.id !== id).map((f) => f.id);
  for (const id of [before[at]!.id, after[at]!.id]) {
    if (same(without(before, id), without(after, id))) {
      return `Move ${numberedName(
        after.find((f) => f.id === id)!,
        after,
      )}`;
    }
  }
  return `Move ${plural(before.filter((f, i) => f.id !== after[i]!.id).length, "step")}`;
}

function paramLabel(before: CadDocument, after: CadDocument): string | null {
  const read = (d: CadDocument, k: string) => d.paramDefs?.[k] ?? d.parameters?.[k];
  const names = new Set([
    ...Object.keys(before.paramDefs ?? before.parameters ?? {}),
    ...Object.keys(after.paramDefs ?? after.parameters ?? {}),
  ]);
  const changed = [...names].filter((k) => !same(read(before, k), read(after, k)));
  if (!changed.length) return null;
  return changed.length === 1 ? `Parameter ${changed[0]}` : STEP_LABEL.parameters;
}

/** What a model step did, read off the document before and after it. */
export function stepLabel(before: CadDocument, after: CadDocument): string {
  const was = before.features;
  const now = after.features;
  const nowIds = new Set(now.map((f) => f.id));
  const wasIds = new Set(was.map((f) => f.id));
  const removed = was.filter((f) => !nowIds.has(f.id));
  if (removed.length)
    return `Delete ${deletedWhat(
      was,
      removed.map((f) => f.id),
    )}`;
  const added = now.filter((f) => !wasIds.has(f.id));
  if (added.length) return added.length === 1 ? numberedName(added[0]!, now) : `Add ${plural(added.length, "step")}`;
  if (was.some((f, i) => f.id !== now[i]!.id)) return movedLabel(was, now);

  const edited = now.filter((f, i) => !same(was[i], f));
  if (edited.length > 1) return `Edit ${plural(edited.length, "step")}`;
  if (edited.length === 1) {
    const at = now.indexOf(edited[0]!);
    const unnamed = (f: Feature) => ({ ...f, name: undefined });
    if (same(unnamed(was[at]!), unnamed(now[at]!))) return `Rename ${numberedName(was[at]!, was)}`;
    return numberedName(now[at]!, now);
  }
  return paramLabel(before, after) ?? STEP_LABEL.edit;
}
