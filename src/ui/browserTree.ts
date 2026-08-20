// The Browser panel's pure helpers.
//
// The panel itself is components/shell/BrowserPane.vue (+ TreeFolder.vue and
// TreeRow.vue); what is left here is the part with real logic and no DOM:
// shaping an imported STEP assembly into the tree the panel paints, and the
// shared body-colour menu. Both are unit-tested directly — see browserTree.test.ts,
// which is a node-environment *.test.ts with no DOM at all.

import type { DocumentStore } from "../document/store";
import type { CtxItem } from "./menu";
import { multiColorEnabled } from "./featureFlags";

/** The "Color" entry for a body's menu, or NOTHING when multi-material is off.
 *
 *  A list to be spread rather than an item to be placed, because the two states
 *  are "an entry with a submenu" and "no entry at all". Returning an item whose
 *  submenu happened to be empty would leave both call sites showing a Color menu
 *  that opens onto nothing, which is the one outcome neither wants — and it
 *  would leave the decision duplicated at both of them.
 *
 *  Shared by the browser-tree row menu and the viewport's right-click body menu
 *  so the two surfaces can't drift. */
export function bodyColorMenu(store: DocumentStore, bodyId: string): CtxItem[] {
  if (!multiColorEnabled()) return [];
  return [{ label: "Color", children: bodyColorMenuItems(store, bodyId) }];
}

/** Palette → menu items for assigning a body's color slot. Exported for the
 *  test that pins the swatches and the disabled current slot; call sites want
 *  `bodyColorMenu` above, which knows when there should be no menu. */
export function bodyColorMenuItems(store: DocumentStore, bodyId: string): CtxItem[] {
  const slot = store.bodyColorSlot(bodyId);
  return [
    ...store.colorPalette.map((s, i) => ({
      label: s.name,
      swatch: s.color,
      disabled: slot === i,
      onClick: () => store.setBodyColorSlot(bodyId, i),
    })),
    { label: "None", disabled: slot == null, onClick: () => store.setBodyColorSlot(bodyId, null) },
  ];
}

/** Indentation for a row/head nested `depth` levels inside its folder. Capped:
 *  the panel is a fixed 232px with no resizer, and the reference assembly is 12
 *  levels deep, so an uncapped step would spend the whole width on whitespace.
 *
 *  Bound as a :style in TreeFolder/TreeRow — e2e/assembly_tree_e2e.cjs reads the
 *  computed paddingLeft back to assert that nesting is visibly indented. */
export function indent(depth: number, base: number): number {
  return base + Math.min(depth, 6) * 8;
}

/** One node of an imported assembly tree, as the browser renders it. */
export interface AsmGroup {
  key: string; // namespaced collapse key, "n:<featureId>/<nodeIndex>"
  label: string;
  children: AsmGroup[];
  bodies: { id: string; name: string }[];
  total: number; // bodies at or below this node — what the count badge shows
}

/** Every body id at or below `g`. */
export function collectBodyIds(g: AsmGroup, out: string[] = []): string[] {
  for (const b of g.bodies) out.push(b.id);
  for (const c of g.children) collectBodyIds(c, out);
  return out;
}

/** Shape imported-assembly bodies into the tree the browser renders.
 *
 *  Pure on purpose — this is the part with real logic (chain walking, sibling
 *  identity, malformed manifests), so it is unit-tested directly rather than
 *  through the DOM. Returns null when no body belongs to an assembly, which is
 *  every document without one; the caller then renders the flat list unchanged.
 *
 *  A body whose `nodeRef` does not resolve goes to `loose` rather than being
 *  dropped: a body missing from the browser is invisible AND unselectable, which
 *  is far worse than one shown at the top level.
 */
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
    for (let i: number | null = leafIndex; i !== null && i >= 0 && i < nodes.length && !seen.has(i); i = nodes[i]!.parent) {
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

  const total = (g: AsmGroup): number =>
    (g.total = g.bodies.length + g.children.reduce((n, c) => n + total(c), 0));
  for (const r of roots) total(r);
  return { roots, loose, ancestors };
}
