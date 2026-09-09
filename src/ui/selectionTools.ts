// What to OFFER for the current selection, the one answer the floating
// selection toolbar renders, and the one the right-click menu ranks its model
// entries by.
//
// Built from ONE kind of the selection, ranked, not from the union: Extrude-the-
// profile and Press/Pull-the-face are different operations on different geometry,
// and offering both invites a click on the one you weren't looking at. The ranking
// is copied from app/viewportWiring.ts, which answers the same question to decide
// which drag handle to mount, and the two MUST agree, the handle on the geometry
// and the toolbar above it are one affordance seen twice.
//
// Membership comes from the selection's KIND, enablement from its COUNT, and the
// two are kept apart because they answer different questions: selectionOffers()
// says what this kind of thing can feed at all, which is the honest answer for a
// menu, while the toolbar shows only what would run right now.

import {
  applicableToolsIn,
  capabilities,
  toolsConsumingIn,
  type AnyToolId,
  type EntityKind,
  type SelectionCounts,
  type ToolId,
} from "../features/toolCapabilities";
import { keyHint } from "../input/shortcuts";

/** Which kind wins when a selection holds several. See the header, this is
 *  app/viewportWiring.ts's drag-handle ranking, and it may not drift from it.
 *
 *  Bodies come last rather than not at all: body selection is a separate mode
 *  (press 2), so in practice it never competes with the other three, and
 *  leaving it off would mean a two-body selection offering nothing while the
 *  booleans sit one keystroke away. */
export const KIND_RANK: readonly EntityKind[] = ["edge", "sketch-region", "face", "body"];

/** Human name for the kind, for a title or a prompt. Singular, callers that
 *  have a count add the plural. */
export const KIND_LABEL: Record<EntityKind, string> = {
  edge: "edge",
  face: "face",
  vertex: "corner",
  body: "body",
  "sketch-region": "profile",
};

/** The kind this selection is primarily made of, or null when it is empty. */
export function primaryKind(sel: SelectionCounts): EntityKind | null {
  return KIND_RANK.find((k) => (sel[k] ?? 0) > 0) ?? null;
}

/** How many entities of the winning kind are selected. */
export function primaryCount(sel: SelectionCounts): number {
  const kind = primaryKind(sel);
  return kind ? (sel[kind] ?? 0) : 0;
}

/** One tool, dressed for a button or a wedge. */
export interface ToolOffer {
  tool: AnyToolId;
  label: string;
  iconName: string;
  /** The id for the central dispatcher (app/actions.ts), or null for the one
   *  tool that has no such id, see ACTIONLESS below. A caller that cannot
   *  handle null must skip the offer rather than dispatch the tool id and
   *  silently do nothing. */
  action: string | null;
  /** Keyboard hint from the single shortcut table, so this can never advertise
   *  a key the keymap does not bind. */
  hint: string | undefined;
  /** The selection actually satisfies this tool's minimum. */
  enabled: boolean;
}

/** Tool id → icon name in ui/icons.ts.
 *
 *  A table rather than a convention (`iconFor(id)` doing string surgery)
 *  because two of them do not match, "delete-face" is drawn by `deleteFace`,
 *  "offset-face" by `offsetFace`, and a convention with exceptions is a
 *  convention that fails silently, on the icon that turns into a blank square.
 *  selectionTools.test.ts holds every tool to having an entry. */
const TOOL_ICON: Record<ToolId, string> = {
  fillet: "fillet",
  chamfer: "chamfer",
  presspull: "presspull",
  extrude: "extrude",
  revolve: "revolve",
  sweep: "sweep",
  loft: "loft",
  "delete-face": "deleteFace",
  move: "move",
  "pattern-linear": "patternLinear",
  "pattern-circular": "patternCircular",
  "boolean-union": "booleanUnion",
  "boolean-subtract": "booleanSubtract",
  "boolean-intersect": "booleanIntersect",
  measure: "measure",
  shell: "shell",
  draft: "draft",
  "offset-face": "offsetFace",
  thicken: "thicken",
  thread: "thread",
};

/** The tools whose id is NOT an action string.
 *
 *  Exactly one, and features/toolCapabilities.ts documents why: face delete is
 *  dispatched through engine.deleteSelectedFace (the Del key and the face
 *  context menu) because it is a selection verb rather than a ribbon command.
 *  It earns its place in the offer anyway, leaving it out would make "what
 *  applies to this face" wrong, so the seam is declared here instead of being
 *  discovered when a click does nothing. */
const ACTIONLESS: ReadonlySet<string> = new Set<string>(["delete-face"]);

/** The mark for a tool: the app's own table first, then whatever the tool
 *  itself declared.
 *
 *  The table wins for the app's own tools because two of them have a name that
 *  is not their id, and it is the exceptions the table exists for. A
 *  contributed tool is not in it and answers from its own capability row, which
 *  is where a plugin put its icon name. Falling back to the id would draw a
 *  blank square, so it is better to have nothing to fall back to: a tool with
 *  no id in either place is not a tool this build can offer, and
 *  `selectionOffers` never sees one, every id it iterates came out of the
 *  merged inventory. */
function iconFor(tool: AnyToolId, declared: string | undefined): string {
  return TOOL_ICON[tool as ToolId] ?? declared ?? "dot";
}

/** Every tool the selection's winning kind can feed, in the capability table's
 *  own preference order, each marked live or not. Empty for an empty
 *  selection. */
export function selectionOffers(sel: SelectionCounts): ToolOffer[] {
  const kind = primaryKind(sel);
  if (!kind) return [];
  // applicableTools() is the authority on "can this run": it is what applies
  // each tool's own minimum (a boolean needs two bodies, Loft two profiles), and
  // re-deriving that from the counts here is exactly the duplication this file
  // exists to avoid.
  // ONE snapshot of the inventory for the whole answer. Asking twice would let
  // a plugin switching itself off between the two calls produce an offer list
  // whose "enabled" flags belong to a different set of tools than its rows.
  const caps = capabilities();
  const live = new Set(applicableToolsIn(caps, sel));
  return toolsConsumingIn(caps, kind, "selection").map((tool) => {
    const cap = caps.get(tool)!;
    return {
      tool,
      label: cap.label,
      iconName: iconFor(tool, cap.icon),
      action: ACTIONLESS.has(tool) ? null : tool,
      hint: keyHint(tool),
      enabled: live.has(tool),
    };
  });
}

/** Verbs the hover bar does not carry however applicable they are.
 *
 *  One, and it is destructive. The bar floats over the part, a button-sized
 *  piece of the thing you are looking at, so a stray click lands on geometry
 *  rather than on chrome, which is a poor place to keep "remove this face and
 *  heal the solid". It stays on Del and in the right-click menu.
 *
 *  A named rule rather than the count that used to produce it. The bar stopped
 *  at five buttons because a pie carried the overflow, and Delete Face fell off
 *  the end only because it happens to sort last; with the pie gone the cap has
 *  nothing behind it, and "the sixth offer is dropped" would have quietly
 *  become "whichever offer is sixth is dropped". */
const BAR_EXCLUDED: ReadonlySet<string> = new Set<string>(["delete-face"]);

/** What the floating toolbar shows: every live offer it is willing to carry.
 *
 *  Uncapped. The cap existed because the pie held what the bar trimmed, and
 *  without it a capped bar would put a verb behind a right-click and nothing
 *  else. */
export function toolbarOffers(sel: SelectionCounts): ToolOffer[] {
  return selectionOffers(sel).filter((o) => o.enabled && !BAR_EXCLUDED.has(o.tool));
}

// --- appearance -------------------------------------------------------------
//
// The verbs that change how a body LOOKS, or whether it is looked at, kept apart
// from the offers above rather than filed as capability rows.
//
// features/toolCapabilities.ts is the inventory of what each MODELLING tool can
// act on: everything in it produces a feature, lands in the timeline and can be
// undone. Material, Hide and Isolate do none of those things, they write the
// document's display-only overlays (see document/store.ts). Giving them rows
// would make `applicableTools()` answer a question it does not ask, and the
// first caller to trust "these are the tools that would add a feature" would be
// wrong.
//
// They are on the bar for the reason the bar exists at all. A body you have
// just picked out of a three-thousand-part import is exactly the body you want
// to colour, to get out of the way, or to be alone with, and all three were
// reachable only by right-clicking it or by finding its row in the tree.

/** The appearance verbs, by id. Not action strings: none of these is a command
 *  the ribbon dispatches, each is a direct write the surface performs. */
export type AppearanceId = "material" | "hide" | "isolate";

export interface AppearanceOffer {
  id: AppearanceId;
  label: string;
  iconName: string;
}

/** What the appearance half of the bar shows for this selection.
 *
 *  Bodies only, and only when the body kind is the one that WINS: a selection
 *  of faces belongs to whatever solid is under them, and "Hide" next to a
 *  picked face would be ambiguous about which of the two it meant. Empty
 *  otherwise, which is what lets the bar decide whether to draw a divider by
 *  looking at the length. */
export function appearanceOffers(sel: SelectionCounts): AppearanceOffer[] {
  if (primaryKind(sel) !== "body") return [];
  const n = sel.body ?? 0;
  const many = n > 1 ? ` ${n} bodies` : "";
  return [
    // Material first: it is the one that is not about visibility, and it is the
    // one this bar was asked for.
    { id: "material", label: many ? `Material for${many}` : "Material", iconName: "material" },
    { id: "hide", label: many ? `Hide${many}` : "Hide body", iconName: "hidden" },
    { id: "isolate", label: many ? `Isolate${many}` : "Isolate body", iconName: "isolate" },
  ];
}
