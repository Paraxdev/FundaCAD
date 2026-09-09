// Elements: the user's own folders over the bodies in a document.
//
// WHY. A body list is fine at ten bodies and unusable at three thousand. An
// imported STEP that carries an XCAF product tree already arrives structured
// (see ui/browserTree.ts), but that covers one format and only when the file
// happened to record it; everything else, an OBJ, a mesh assembly, a model built
// by hand, lands as one flat run of rows with no way to say what belongs with
// what. Elements are that way: a named folder, nestable, that bodies are moved
// into. A body in no element is an ORPHAN and shows where it always did.
//
// WHAT AN ELEMENT IS NOT. It is not geometry and it is not a feature. Nothing
// here reaches the sidecar, nothing here changes a rebuild, and a document whose
// elements are all deleted builds byte-identically to one that never had any.
// That is deliberate: organising an import must never be able to change it.
//
// This module is the pure half, no store, no Vue, no DOM. Every operation is a
// function from the current tables to the next ones, which is what lets the
// awkward cases (a parent that no longer exists, a cycle in a hand-edited file,
// deleting a folder with a thousand parts in it) be tested directly instead of
// through a panel.

/** One folder. `parent` is another element's id, absent at the top level.
 *
 *  Absent rather than null, the same omit-when-empty discipline every other
 *  persisted field in this document follows, so a top-level element is
 *  `{id,name}` on disk and stays byte-stable. */
export interface ElementDef {
  id: string;
  name: string;
  parent?: string;
}

/** Roots first, then each element's children, in list order.
 *
 *  An element whose `parent` names nothing counts as a root, and so does one
 *  caught in a cycle (see `ancestryOf`). Both are the same rule: a folder that
 *  cannot be placed is shown at the top rather than dropped, because a folder
 *  that is not drawn is a folder whose contents have vanished. */
export function childrenByParent(
  elements: readonly ElementDef[],
): Map<string, ElementDef[]> {
  const byId = new Map(elements.map((e) => [e.id, e]));
  // Cyclic membership decided ONCE for the whole list, not per element: the
  // obvious `elements.filter(e => isCyclic(elements, e.id))` is quadratic, and
  // this runs on every repaint of a panel that may be listing an entire
  // assembly. One walk per element, each stopping at the first node already
  // classified, so the whole pass is linear in the list.
  const cyclic = new Set<string>();
  const settled = new Set<string>();
  for (const e of elements) {
    if (settled.has(e.id)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur: string | undefined = e.id;
    while (cur && byId.has(cur) && !settled.has(cur) && !onPath.has(cur)) {
      onPath.add(cur);
      path.push(cur);
      cur = byId.get(cur)!.parent;
    }
    // Only a loop CLOSED on this walk marks anything: from where the walk came
    // back on itself, onward. What hangs off a cycle is not in it, and stays
    // reachable, because the cycle's own members are lifted to the top.
    const from = cur !== undefined && onPath.has(cur) ? path.indexOf(cur) : path.length;
    for (let i = 0; i < path.length; i++) {
      settled.add(path[i]!);
      if (i >= from) cyclic.add(path[i]!);
    }
  }
  const out = new Map<string, ElementDef[]>();
  for (const e of elements) {
    const parent = e.parent && byId.has(e.parent) && !cyclic.has(e.id) ? e.parent : "";
    let list = out.get(parent);
    if (!list) out.set(parent, (list = []));
    list.push(e);
  }
  return out;
}

/** `id` and every ancestor above it, nearest first, stopping at the first
 *  repeat. The stop is what makes a hand-edited cycle finite rather than a hang;
 *  `isCyclic` below is the same walk asking a different question. */
export function ancestryOf(elements: readonly ElementDef[], id: string): string[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (let cur: string | undefined = id; cur && !seen.has(cur); cur = byId.get(cur)?.parent) {
    if (!byId.has(cur)) break;
    seen.add(cur);
    out.push(cur);
  }
  return out;
}

/** Does walking up from `id` come back to `id`? */
export function isCyclic(elements: readonly ElementDef[], id: string): boolean {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const seen = new Set<string>();
  let cur = byId.get(id)?.parent;
  while (cur && !seen.has(cur)) {
    if (cur === id) return true;
    seen.add(cur);
    cur = byId.get(cur)?.parent;
  }
  return false;
}

/** `id` and everything below it. What "delete this folder" and "hide this
 *  folder" both have to know, and what stops a move from burying a folder
 *  inside itself. */
export function descendantsOf(elements: readonly ElementDef[], id: string): Set<string> {
  const kids = childrenByParent(elements);
  const out = new Set<string>([id]);
  const queue = [id];
  while (queue.length) {
    for (const c of kids.get(queue.pop()!) ?? []) {
      if (out.has(c.id)) continue; // a cycle in a hand-edited file
      out.add(c.id);
      queue.push(c.id);
    }
  }
  return out;
}

/** Would parenting `id` under `parent` make a loop?
 *
 *  True when the target is the element itself or anything under it, which is
 *  the whole of the rule: dropping a folder onto its own child is the gesture
 *  that produces a subtree nothing can reach, and the drop has to be refused
 *  rather than repaired afterwards. A `parent` of null (top level) is always
 *  allowed. */
export function wouldCycle(
  elements: readonly ElementDef[],
  id: string,
  parent: string | null,
): boolean {
  return parent !== null && descendantsOf(elements, id).has(parent);
}

/** `elements` with `id` moved under `parent` (null = top level), or the list
 *  unchanged when that move would loop or names an element that is not there. */
export function reparented(
  elements: readonly ElementDef[],
  id: string,
  parent: string | null,
): ElementDef[] {
  if (!elements.some((e) => e.id === id)) return [...elements];
  if (parent !== null && !elements.some((e) => e.id === parent)) return [...elements];
  if (wouldCycle(elements, id, parent)) return [...elements];
  return elements.map((e) => {
    if (e.id !== id) return e;
    const next: ElementDef = { id: e.id, name: e.name };
    if (parent !== null) next.parent = parent;
    return next;
  });
}

/** Delete `id`, LIFTING what it held into its own parent.
 *
 *  Not deleting the subtree, which is the other thing this could have meant and
 *  is the wrong one: an element is a label on bodies that exist independently of
 *  it, so a folder delete that took its contents with it would be a way to lose
 *  three thousand parts by right-clicking a row and reading "Delete". Nothing
 *  here removes a body from the document; only the timeline can do that.
 *
 *  Returns the new element list and the reassignments the caller has to make to
 *  its body map, rather than doing both, because the two live in different
 *  places in the store and one of them has to be applied per body id. */
export function withElementRemoved(
  elements: readonly ElementDef[],
  id: string,
): { elements: ElementDef[]; movedTo: string | null } {
  const gone = elements.find((e) => e.id === id);
  if (!gone) return { elements: [...elements], movedTo: null };
  const up = gone.parent && elements.some((e) => e.id === gone.parent) ? gone.parent : null;
  const out: ElementDef[] = [];
  for (const e of elements) {
    if (e.id === id) continue;
    if (e.parent !== id) {
      out.push(e);
      continue;
    }
    const next: ElementDef = { id: e.id, name: e.name };
    if (up !== null) next.parent = up;
    out.push(next);
  }
  return { elements: out, movedTo: up };
}

/** A name no sibling of `parent` already uses: "Element", then "Element 2", …
 *
 *  Unique among SIBLINGS rather than globally, because "Bracket" under two
 *  different subassemblies is how real assemblies are named and renaming one of
 *  them would be inventing a distinction the user did not make. */
export function freshElementName(
  elements: readonly ElementDef[],
  parent: string | null,
  base = "Element",
): string {
  const taken = new Set(
    elements
      .filter((e) => (e.parent ?? null) === parent)
      .map((e) => e.name.toLowerCase()),
  );
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}
