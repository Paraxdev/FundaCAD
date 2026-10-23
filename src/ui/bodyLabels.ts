import type { DocumentStore } from "../document/store";

interface NamedBody {
  id: string;
  name?: string | null;
}

/** Each body's picker label: the user's name for it, else the engine's, with " 2", " 3" on repeats in the order given. */
export function bodyLabels(
  bodies: readonly NamedBody[],
  userName: (id: string) => string | undefined = () => undefined,
): Map<string, string> {
  const base = bodies.map((b) => userName(b.id) || b.name || b.id);
  const taken = new Set(base);
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  bodies.forEach((b, i) => {
    const name = base[i]!;
    let n = (seen.get(name) ?? 0) + 1;
    let label = name;
    if (n > 1) {
      while (taken.has(`${name} ${n}`)) n++;
      label = `${name} ${n}`;
      taken.add(label);
    }
    seen.set(name, n);
    out.set(b.id, label);
  });
  return out;
}

/** The built bodies in build order, each named by its picker label. */
export function labelledBodies(store: Pick<DocumentStore, "buildState" | "bodyName">): { id: string; name: string }[] {
  const bodies = store.buildState.result?.bodies ?? [];
  const labels = bodyLabels(bodies, (id) => store.bodyName(id));
  return bodies.map((b) => ({ id: b.id, name: labels.get(b.id)! }));
}
