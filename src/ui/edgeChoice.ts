// Labels for an ambiguous edge pick menu (viewport/edgeTies.ts). The body usually separates coincident edges, the
// feature separates two edges of one body. Each fallback must stay readable, never "undefined".

/** The feature owning most of a body's faces. Stable beats exhaustive here: the label must not change as the mouse
 *  moves. Null when the backend supplies no faceOwners. */
export function dominantOwner(faceOwners: readonly (string | null)[] | undefined): string | null {
  if (!faceOwners?.length) return null;
  const counts = new Map<string, number>();
  for (const o of faceOwners) {
    if (o) counts.set(o, (counts.get(o) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [id, n] of counts) {
    // Ties break on the id so the label does not depend on Map iteration order.
    if (n > bestN || (n === bestN && best !== null && id < best)) {
      best = id;
      bestN = n;
    }
  }
  return best;
}

/** General to specific, like the browser tree; missing parts are dropped. A feature equal to the body name is dropped
 *  too ("Edge · Box · Box"), compared by name not label since a numbered "Box 1" would slip through. */
export function edgeChoiceLabel(
  bodyLabel: string | null,
  featureName: string | null,
  bodyName: string | null = bodyLabel,
): string {
  const feature = featureName && featureName !== bodyName ? featureName : null;
  return ["Edge", bodyLabel, feature].filter((s): s is string => !!s).join(" · ");
}

/** Numbered by the body's place in the browser when another candidate shares its name, so "Box 2" is the second Box
 *  in the tree. */
export function bodyRowLabel(name: string | null, index: number, sharedByOthers: boolean): string | null {
  if (!name) return null;
  return sharedByOthers && index >= 0 ? `${name} ${index + 1}` : name;
}

/** Last resort: edgeTies.ts drops a choice whose entries read alike, which would leave two edges of one unnamed body
 *  impossible to offer. */
export function distinguish(labels: readonly string[]): string[] {
  const seen = new Map<string, number>();
  const total = new Map<string, number>();
  for (const l of labels) total.set(l, (total.get(l) ?? 0) + 1);
  return labels.map((l) => {
    if ((total.get(l) ?? 0) < 2) return l;
    const n = (seen.get(l) ?? 0) + 1;
    seen.set(l, n);
    return `${l} (${n})`;
  });
}
