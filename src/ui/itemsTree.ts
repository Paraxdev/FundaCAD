import type { TreeMeta } from "../components/ui/treeContext";

/** What the Items tree reads of a node in the panel's flat list. */
export type ItemsNode =
  | { kind: "folder"; k: string; depth: number; collapsed: boolean; label: string }
  | { kind: "row"; k: string; depth: number; label: string }
  | { kind: "empty"; k: string }
  | { kind: "plugin"; k: string };

/** The tree's rows in drawn order, one level per depth. An empty note sits under the head before it and cannot be
 *  reached by the arrows; a plugin section is a group of its own and has no row here. */
export function itemsTreeMeta(nodes: readonly ItemsNode[]): TreeMeta[] {
  const out: TreeMeta[] = [];
  let head = 0;
  for (const n of nodes) {
    if (n.kind === "folder") {
      head = n.depth + 1;
      out.push({ key: n.k, level: head, expandable: true, expanded: !n.collapsed, label: n.label });
    } else if (n.kind === "row") out.push({ key: n.k, level: n.depth + 1, label: n.label });
    else if (n.kind === "empty") out.push({ key: n.k, level: head + 1, disabled: true });
  }
  return out;
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
