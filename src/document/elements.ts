// Elements: user folders over the bodies, pure functions over the tables. Nothing here reaches the engine, so a
// document builds byte-identically with or without them; organising an import must never change it.

// `parent` is absent, not null, at the top level, so a top-level element stays `{id,name}` on disk.
export interface ElementDef {
  id: string;
  name: string;
  parent?: string;
}

// An element whose parent is missing or caught in a cycle counts as a root: a folder not drawn hides its contents.
export function childrenByParent(elements: readonly ElementDef[]): Map<string, ElementDef[]> {
  const byId = new Map(elements.map((e) => [e.id, e]));
  // Cycles are decided once for the whole list: per element would be quadratic, and this runs on every panel repaint.
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
    // Only a loop closed on this walk marks anything; what hangs off a cycle stays reachable once the cycle is lifted.
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

// Nearest first, stopping at the first repeat, so a hand-edited cycle is finite rather than a hang.
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

// A drop onto the element itself or its own child would make an unreachable subtree, so it is refused, not repaired.
export function wouldCycle(elements: readonly ElementDef[], id: string, parent: string | null): boolean {
  return parent !== null && descendantsOf(elements, id).has(parent);
}

// Unchanged when the move would loop or names a missing element.
export function reparented(elements: readonly ElementDef[], id: string, parent: string | null): ElementDef[] {
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

// Lifts the children into the parent instead of deleting the subtree: elements only label bodies, so a folder delete
// must never lose parts. Returns the body map reassignments for the caller, which applies them per body id.
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

// Unique among siblings only: "Bracket" under two subassemblies is how real assemblies are named.
export function freshElementName(elements: readonly ElementDef[], parent: string | null, base = "Element"): string {
  const taken = new Set(elements.filter((e) => (e.parent ?? null) === parent).map((e) => e.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}
