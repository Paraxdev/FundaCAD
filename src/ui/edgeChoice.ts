// Naming the edges in an ambiguous-pick menu.
//
// When a click lands on two edges at once (viewport/edgeTies.ts), the menu has
// to say what each one IS, and it has one line to do it in. Whatever it says has
// to distinguish them — a menu offering the same sentence twice is worse than
// guessing, and edgeTies.ts drops the whole question when it would.
//
// Two facts identify a solid's edge to a user: the body it belongs to, and the
// operation that made it. Coincident edges are almost always two bodies meeting,
// so the body alone usually separates them; the feature is what separates two
// edges of ONE body, which is the case a boolean leaves behind.
//
// Pure, and split from the wiring, because the interesting part is the fallbacks:
// a body with no name, a body whose faces have no recorded owner, and a feature
// id that no longer resolves are all normal, and each has to degrade to
// something still readable rather than to "undefined".

/** Which feature owns most of a body's faces — the operation that made it.
 *
 *  A body's faces can carry several owners: a boolean leaves the tool's faces
 *  tagged with the tool's feature and the target's with the target's. The most
 *  common one is the honest short answer to "what is this body", and it is
 *  stable, which matters more here than being exhaustively correct: the label
 *  exists to tell two menu rows apart, and a label that changed as the user
 *  moved the mouse would fail at that.
 *
 *  Null when nothing is recorded, which is every backend that does not supply
 *  faceOwners.
 */
export function dominantOwner(faceOwners: readonly (string | null)[] | undefined): string | null {
  if (!faceOwners?.length) return null;
  const counts = new Map<string, number>();
  for (const o of faceOwners) {
    if (o) counts.set(o, (counts.get(o) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [id, n] of counts) {
    // Ties break on the id, so the answer does not depend on Map iteration
    // order — two runs over the same body must label it the same way.
    if (n > bestN || (n === bestN && best !== null && id < best)) {
      best = id;
      bestN = n;
    }
  }
  return best;
}

/** One menu row's text.
 *
 *  Reads as a path from the general to the specific, which is the order the
 *  browser tree already puts them in: what it is, which body, which operation.
 *  Missing parts are dropped rather than filled with a placeholder — "Edge" on
 *  its own is honest, and "Edge · unknown body" is noise wearing a fact's
 *  clothes.
 *
 *  A feature that repeats the body's own name is dropped too. Primitives name
 *  their body after themselves, so a box's edge came out as "Edge · Box · Box":
 *  the second half looks like it is telling you something, spends the row's
 *  width, and says the same word again.
 *
 *  That comparison is against the body's NAME, which is why it is a separate
 *  argument from the label. Once two bodies called "Box" have been numbered
 *  apart, "Box 1" no longer equals "Box" and the repeat would sail straight
 *  through the test it exists to fail.
 */
export function edgeChoiceLabel(
  bodyLabel: string | null,
  featureName: string | null,
  bodyName: string | null = bodyLabel,
): string {
  const feature = featureName && featureName !== bodyName ? featureName : null;
  return ["Edge", bodyLabel, feature].filter((s): s is string => !!s).join(" · ");
}

/** A body's label for a menu row: its name, numbered by its position in the
 *  body list when another candidate carries the same name.
 *
 *  Two boxes are both called "Box", so the name alone cannot tell the rows
 *  apart — and the number that CAN is not an arbitrary counter but the body's
 *  place in the browser, so "Box 2" in the menu is the second Box in the tree
 *  rather than the second row of this particular menu.
 */
export function bodyRowLabel(
  name: string | null,
  index: number,
  sharedByOthers: boolean,
): string | null {
  if (!name) return null;
  return sharedByOthers && index >= 0 ? `${name} ${index + 1}` : name;
}

/** Make a set of labels distinguishable, in place of the caller's judgement.
 *
 *  The last resort, and it exists because edgeTies.ts drops any choice whose
 *  entries read alike: without this, two edges of one unnamed body would be
 *  silently un-offerable and the user would be back to the arbitrary pick this
 *  whole path exists to remove. Numbering them says less than a name would, but
 *  it still says "there are two, and they are not the same one".
 */
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
