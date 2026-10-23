// Pure helpers for the Browser panel (components/shell/BrowserPane.vue), unit-tested without a DOM.

import type { CtxItem } from "./menu";
import { contributedBodyMenu } from "../plugins/contrib";
import { ancestryOf, childrenByParent, type ElementDef } from "../document/elements";
import type { MaterialDef } from "../document/materials";
import type { CadDocument, ImportColorSource } from "../types";

/** Shared by the tree row menu and the viewport body menu so the two cannot drift. */
export function bodyExtraMenu(bodyId: string): CtxItem[] {
  return contributedBodyMenu(bodyId);
}

/** A caret plus the head gap (12px + 8px), so a child caret sits under its parent icon; a leaf takes one more step.
 *  Capped as the panel has no horizontal scroll. e2e/assembly_tree_e2e.cjs reads paddingLeft back. */
const INDENT_STEP = 20;
const INDENT_BASE = 4;

export function folderIndent(depth: number): number {
  return INDENT_BASE + Math.min(depth, 6) * INDENT_STEP;
}

export function rowIndent(depth: number): number {
  return folderIndent(depth) + INDENT_STEP;
}

export interface AsmGroup {
  key: string; // namespaced collapse key, "n:<featureId>/<nodeIndex>"
  label: string;
  children: AsmGroup[];
  bodies: { id: string; name: string }[];
  total: number; // bodies at or below this node, what the count badge shows
}

export function collectBodyIds(g: AsmGroup, out: string[] = []): string[] {
  for (const b of g.bodies) out.push(b.id);
  for (const c of g.children) collectBodyIds(c, out);
  return out;
}

/** Null when no body belongs to an assembly. A body whose `nodeRef` does not resolve goes to `loose`, since a dropped
 *  body would be invisible and unselectable. */
export function buildAssemblyGroups(
  bodies: readonly { id: string; name: string; nodeRef?: string }[],
  trees: ReadonlyMap<string, readonly { name: string; parent: number | null }[]>,
): {
  roots: AsmGroup[];
  loose: { id: string; name: string }[];
  ancestors: Map<string, string[]>;
} | null {
  if (!bodies.some((b) => b.nodeRef)) return null;

  const roots: AsmGroup[] = [];
  const byKey = new Map<string, AsmGroup>();
  const loose: { id: string; name: string }[] = [];
  const ancestors = new Map<string, string[]>();

  for (const b of bodies) {
    const slash = b.nodeRef ? b.nodeRef.lastIndexOf("/") : -1;
    const featureId = slash > 0 ? b.nodeRef!.slice(0, slash) : "";
    const nodes = featureId ? trees.get(featureId) : undefined;
    const leafIndex = slash > 0 ? Number(b.nodeRef!.slice(slash + 1)) : NaN;
    if (!nodes || !Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= nodes.length) {
      loose.push({ id: b.id, name: b.name });
      continue;
    }
    // walk leaf -> root, guarding against a cyclic `parent` in a hand-edited file
    const chain: number[] = [];
    const seen = new Set<number>();
    for (
      let i: number | null = leafIndex;
      i !== null && i >= 0 && i < nodes.length && !seen.has(i);
      i = nodes[i]!.parent
    ) {
      seen.add(i);
      chain.unshift(i);
    }
    let siblings = roots;
    let group: AsmGroup | undefined;
    const chainKeys: string[] = [];
    for (const index of chain) {
      const key = `n:${featureId}/${index}`;
      let next = byKey.get(key);
      if (!next) {
        next = { key, label: nodes[index]!.name || "Part", children: [], bodies: [], total: 0 };
        byKey.set(key, next);
        siblings.push(next);
      }
      chainKeys.push(key);
      group = next;
      siblings = next.children;
    }
    if (!group) {
      loose.push({ id: b.id, name: b.name });
      continue;
    }
    group.bodies.push({ id: b.id, name: b.name });
    ancestors.set(b.id, chainKeys);
  }

  const total = (g: AsmGroup): number => (g.total = g.bodies.length + g.children.reduce((n, c) => n + total(c), 0));
  for (const r of roots) total(r);
  return { roots, loose, ancestors };
}

export interface BodyRef {
  id: string;
  name: string;
}

/** One shape for elements and assembly nodes; `kind` matters only where they differ: an element can be renamed,
 *  deleted and dropped onto, an assembly node cannot. */
export interface TreeGroup {
  kind: "element" | "assembly";
  /** Absent on an assembly node, which has only a position in a manifest. */
  id?: string;
  key: string; // collapse key: "e:<elementId>" or "n:<featureId>/<nodeIndex>"
  label: string;
  children: TreeGroup[];
  bodies: BodyRef[];
  total: number; // bodies at or below here, what the count badge shows
}

export function collectGroupBodyIds(g: TreeGroup, out: string[] = []): string[] {
  for (const b of g.bodies) out.push(b.id);
  for (const c of g.children) collectGroupBodyIds(c, out);
  return out;
}

function fromAsm(g: AsmGroup): TreeGroup {
  return {
    kind: "assembly",
    key: g.key,
    label: g.label,
    children: g.children.map(fromAsm),
    bodies: g.bodies,
    total: g.total,
  };
}

/** featureId → the assembly manifest an import feature carries. */
export function importTrees(doc: CadDocument): Map<string, { name: string; parent: number | null }[]> {
  const trees = new Map<string, { name: string; parent: number | null }[]>();
  for (const f of doc.features) {
    const nodes = (f as { nodes?: { name: string; parent: number | null }[] }).nodes;
    if (f.type === "import" && nodes) trees.set(f.id, nodes);
  }
  return trees;
}

/** Elements first, then the imported assembly structure, then the rest. A body the user filed shows only in its
 *  element, whatever its file said. Empty elements are kept so they can be dropped into. Never null. */
export function buildBodyTree(
  bodies: readonly { id: string; name: string; nodeRef?: string }[],
  trees: ReadonlyMap<string, readonly { name: string; parent: number | null }[]>,
  elements: readonly ElementDef[],
  bodyElement: ReadonlyMap<string, string>,
): { groups: TreeGroup[]; loose: BodyRef[]; ancestors: Map<string, string[]> } {
  const known = new Set(elements.map((e) => e.id));
  const held = new Map<string, BodyRef[]>();
  const rest: { id: string; name: string; nodeRef?: string }[] = [];
  for (const b of bodies) {
    const e = bodyElement.get(b.id);
    if (e && known.has(e)) {
      let list = held.get(e);
      if (!list) held.set(e, (list = []));
      list.push({ id: b.id, name: b.name });
    } else {
      rest.push(b);
    }
  }

  const ancestors = new Map<string, string[]>();
  const kids = childrenByParent(elements);
  const walk = (e: ElementDef, chain: readonly string[]): TreeGroup => {
    const key = `e:${e.id}`;
    const here = [...chain, key];
    const g: TreeGroup = {
      kind: "element",
      id: e.id,
      key,
      label: e.name,
      children: (kids.get(e.id) ?? []).map((c) => walk(c, here)),
      bodies: held.get(e.id) ?? [],
      total: 0,
    };
    for (const b of g.bodies) ancestors.set(b.id, here);
    g.total = g.bodies.length + g.children.reduce((n, c) => n + c.total, 0);
    return g;
  };
  const groups = (kids.get("") ?? []).map((e) => walk(e, []));

  const asm = buildAssemblyGroups(rest, trees);
  if (asm) {
    for (const [id, chain] of asm.ancestors) ancestors.set(id, chain);
    groups.push(...asm.roots.map(fromAsm));
  }
  return { groups, loose: asm ? asm.loose : rest.map((b) => ({ id: b.id, name: b.name })), ancestors };
}

/** "Chassis / Frame": the menu opens one flyout level and elements nest without limit, so the label holds the path. */
export function elementPath(elements: readonly ElementDef[], id: string): string {
  const names = new Map(elements.map((e) => [e.id, e.name]));
  return ancestryOf(elements, id)
    .map((e) => names.get(e) ?? e)
    .reverse()
    .join(" / ");
}

/** Shared by the Browser row menu and the viewport body menu. `from` only greys out the no-op row, and comes from one
 *  body since a mixed selection is ordinary when merging folders. */
export function elementMoveMenu(
  elements: readonly ElementDef[],
  ids: readonly string[],
  from: string | undefined,
  act: { toNew: () => void; to: (element: string | null) => void },
): CtxItem {
  const rows: CtxItem[] = [{ label: "New element…", onClick: act.toNew }];
  if (elements.length) {
    rows.push({ separator: true, label: "" });
    rows.push({ label: "Top level", disabled: from === undefined, onClick: () => act.to(null) });
    for (const e of elements) {
      rows.push({
        label: elementPath(elements, e.id),
        disabled: e.id === from,
        onClick: () => act.to(e.id),
      });
    }
  }
  return { label: ids.length > 1 ? `Move ${ids.length} bodies to` : "Move to", children: rows };
}

/** Shared like elementMoveMenu. No "New material…" row: a modal would cover the model the user pointed at. */
export function materialMenu(
  materials: readonly MaterialDef[],
  ids: readonly string[],
  current: string | undefined,
  apply: (material: string | null) => void,
  /** Offered only when some faces have their own material. A body assignment deliberately leaves them, so this is the
   *  only way back from the tree. */
  faces?: { count: number; clear: () => void },
): CtxItem {
  const rows: CtxItem[] = materials.map((m) => ({
    label: m.name,
    swatch: m.color,
    disabled: m.id === current,
    onClick: () => apply(m.id),
  }));
  rows.push({ label: "None", disabled: current === undefined, onClick: () => apply(null) });
  if (faces?.count) {
    rows.push({ separator: true, label: "" });
    rows.push({
      label: `Clear ${faces.count} dressed ${faces.count === 1 ? "face" : "faces"}`,
      onClick: faces.clear,
    });
  }
  return { label: ids.length > 1 ? `Material for ${ids.length} bodies` : "Material", children: rows };
}

/** Where an imported assembly's parts take their colours from, for a file that
 *  styles a part's body one colour and its faces another. */
export function importColorMenu(current: ImportColorSource, apply: (source: ImportColorSource) => void): CtxItem {
  return {
    label: "Imported colors",
    children: [
      { label: "From bodies", disabled: current === "bodies", onClick: () => apply("bodies") },
      { label: "From faces", disabled: current === "faces", onClick: () => apply("faces") },
    ],
  };
}
