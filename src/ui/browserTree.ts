// The Browser panel's pure helpers.
//
// The panel itself is components/shell/BrowserPane.vue (+ TreeFolder.vue and
// TreeRow.vue); what is left here is the part with real logic and no DOM:
// shaping an imported STEP assembly into the tree the panel paints, and the
// shared body-colour menu. Both are unit-tested directly, see browserTree.test.ts,
// which is a node-environment *.test.ts with no DOM at all.

import type { CtxItem } from "./menu";
import { contributedBodyMenu } from "../plugins/contrib";
import { ancestryOf, childrenByParent, type ElementDef } from "../document/elements";
import type { MaterialDef } from "../document/materials";

/** The rows a plugin adds to a body's right-click menu.
 *
 *  A list to be spread rather than an item to be placed, because the two states
 *  are "some entries" and "no entry at all". Shared by the browser-tree row menu
 *  and the viewport's body menu so the two surfaces cannot drift.
 *
 *  A "Color" submenu built from the document's palette used to be written out
 *  here, behind a check on the capability that owns palettes. Both are gone: the
 *  submenu is contributed by that capability, and this file no longer knows that
 *  a body can have a colour.
 *
 *  Kept as a named function rather than calling the registry at both sites,
 *  because those two are also where a THIRD surface would come looking, and one
 *  name is easier to find than two call sites. */
export function bodyExtraMenu(bodyId: string): CtxItem[] {
  return contributedBodyMenu(bodyId);
}

/** Indentation for a row/head nested `depth` levels inside its folder. Capped:
 *  the panel is a fixed 232px with no resizer, and the reference assembly is 12
 *  levels deep, so an uncapped step would spend the whole width on whitespace.
 *
 *  Bound as a :style in TreeFolder/TreeRow, e2e/assembly_tree_e2e.cjs reads the
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
  total: number; // bodies at or below this node, what the count badge shows
}

/** Every body id at or below `g`. */
export function collectBodyIds(g: AsmGroup, out: string[] = []): string[] {
  for (const b of g.bodies) out.push(b.id);
  for (const c of g.children) collectBodyIds(c, out);
  return out;
}

/** Shape imported-assembly bodies into the tree the browser renders.
 *
 *  Pure on purpose, this is the part with real logic (chain walking, sibling
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

// --- the whole body tree: the user's elements over the imports' own -----------

/** A body as the tree carries it. */
export interface BodyRef {
  id: string;
  name: string;
}

/** One folder in the Browser's body tree, from either source.
 *
 *  ONE shape for both kinds rather than two, because everything the panel does
 *  with a folder, indent it, count it, collapse it, toggle every body under it,
 *  is the same for both, and `kind` is consulted only where they genuinely
 *  differ: an element can be renamed, deleted and dropped onto, an assembly node
 *  is a fact about a file and can be none of those. */
export interface TreeGroup {
  kind: "element" | "assembly";
  /** The element's id. Absent on an assembly node, which has no id of its own,
   *  only a position in a manifest. */
  id?: string;
  key: string; // collapse key: "e:<elementId>" or "n:<featureId>/<nodeIndex>"
  label: string;
  children: TreeGroup[];
  bodies: BodyRef[];
  total: number; // bodies at or below here, what the count badge shows
}

/** Every body id at or below `g`. */
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

/** The Browser's whole body tree: the user's elements first, then whatever
 *  assembly structure the imports brought with them, then the rest.
 *
 *  AN ELEMENT ASSIGNMENT WINS. A body the user has filed shows in that folder
 *  and nowhere else, including when the file it came from had an opinion about
 *  where it belonged. That is the entire point of the feature: an imported tree
 *  is a record of how somebody else's CAD system organised the part, and it is
 *  frequently not how this document wants it. Bodies left alone keep the
 *  imported structure exactly as they had it, so opening an assembly and
 *  changing nothing looks the way it always did.
 *
 *  Empty elements are kept. A folder made and not yet filled is the first half
 *  of every organising gesture there is, and one that vanished until something
 *  was dropped in it could never be dropped into.
 *
 *  Always returns a tree, never null: a document with no elements and no
 *  imported assembly comes back as `groups: []` plus every body in `loose`,
 *  which is the flat list the panel has always drawn. */
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

/** "Chassis / Frame": the path that tells two folders of the same name apart in
 *  a flat menu. The context menu opens one level of flyout and elements nest
 *  without limit, so the nesting has to go in the label. */
export function elementPath(elements: readonly ElementDef[], id: string): string {
  const names = new Map(elements.map((e) => [e.id, e.name]));
  return ancestryOf(elements, id)
    .map((e) => names.get(e) ?? e)
    .reverse()
    .join(" / ");
}

/** The "Move to" submenu for a set of bodies, shared by the Browser row menu and
 *  the viewport's body menu so the two cannot drift.
 *
 *  `from` is the element they are in now, undefined for orphans, and only
 *  greys out the row that would be a no-op. It is taken from ONE of the bodies:
 *  a mixed selection is the ordinary case when several folders are being merged,
 *  and every destination is legal for it. */
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

/** The "Material" submenu for a set of bodies, shared by the Browser row menu
 *  and the viewport's body menu, exactly as elementMoveMenu above is.
 *
 *  A flat list of the library with a swatch on each row, and "None" at the
 *  bottom for going back to the default grey. No "New material…" here: making
 *  one is dialling in a colour and three sliders, which is the dialog's job, and
 *  a context menu that opened a modal over the model the user was pointing at
 *  would be a menu that took the thing they were aiming at away. */
export function materialMenu(
  materials: readonly MaterialDef[],
  ids: readonly string[],
  current: string | undefined,
  apply: (material: string | null) => void,
): CtxItem {
  const rows: CtxItem[] = materials.map((m) => ({
    label: m.name,
    swatch: m.color,
    disabled: m.id === current,
    onClick: () => apply(m.id),
  }));
  rows.push({ label: "None", disabled: current === undefined, onClick: () => apply(null) });
  return { label: ids.length > 1 ? `Material for ${ids.length} bodies` : "Material", children: rows };
}
