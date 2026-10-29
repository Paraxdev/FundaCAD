import type { TreeMeta } from "../components/ui/treeContext";

/** What the Items tree reads of a node in the panel's flat list. */
export type ItemsNode =
  | { kind: "folder"; k: string; depth: number; collapsed: boolean; label: string }
  | { kind: "row"; k: string; depth: number; label: string }
  | { kind: "empty"; k: string }
  | { kind: "plugin"; k: string; label: string; empty?: boolean | undefined };

/** The tree's rows in drawn order, one level per depth. An empty note sits under the head before it and cannot be
 *  reached by the arrows; a plugin section is a top row that holds its own controls, and is no row while it draws
 *  nothing. */
export function itemsTreeMeta(nodes: readonly ItemsNode[]): TreeMeta[] {
  const out: TreeMeta[] = [];
  let head = 0;
  for (const n of nodes) {
    if (n.kind === "folder") {
      head = n.depth + 1;
      out.push({ key: n.k, level: head, expandable: true, expanded: !n.collapsed, label: n.label });
    } else if (n.kind === "row") out.push({ key: n.k, level: n.depth + 1, label: n.label });
    else if (n.kind === "empty") out.push({ key: n.k, level: head + 1, disabled: true });
    else if (!n.empty) out.push({ key: n.k, level: 1, label: n.label });
  }
  return out;
}

export type ItemsMove =
  { kind: "past"; id: string; sibling: string; label: string } | { kind: "end" } | { kind: "fixed" };

// Planes, datums, joints, mechanisms and sketches are timeline features. Origin planes, bodies and heads keep the order
// the model or the panel gives them.
const FEATURE_ROW = /^[pdjms]:(.+)$/;

/** Where Alt+Up (-1) or Alt+Down (1) takes a row: past its neighbour at the same level under the same head. */
export function itemsMove(nodes: readonly ItemsNode[], key: string, delta: -1 | 1): ItemsMove {
  const i = nodes.findIndex((n) => n.k === key);
  const n = nodes[i];
  const id = n?.kind === "row" ? FEATURE_ROW.exec(n.k)?.[1] : undefined;
  if (!n || n.kind !== "row" || id === undefined) return { kind: "fixed" };
  for (let j = i + delta; j >= 0 && j < nodes.length; j += delta) {
    const m = nodes[j]!;
    if (m.kind !== "row" || m.depth < n.depth) break;
    if (m.depth > n.depth) continue;
    const sibling = FEATURE_ROW.exec(m.k)?.[1];
    return sibling === undefined ? { kind: "end" } : { kind: "past", id, sibling, label: m.label };
  }
  return { kind: "end" };
}

/** A plugin section's key as words: "referenceImages" reads "Reference images". */
export function sectionName(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_.:]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
