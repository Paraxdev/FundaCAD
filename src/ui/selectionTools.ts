// What to OFFER for the current selection — the one answer the floating
// selection toolbar renders, and the one the right-click menu ranks its model
// entries by.
//
// Built from ONE kind of the selection, ranked, not from the union: Extrude-the-
// profile and Press/Pull-the-face are different operations on different geometry,
// and offering both invites a click on the one you weren't looking at. The ranking
// is copied from app/viewportWiring.ts, which answers the same question to decide
// which drag handle to mount, and the two MUST agree — the handle on the geometry
// and the toolbar above it are one affordance seen twice.
//
// Membership comes from the selection's KIND, enablement from its COUNT, and the
// two are kept apart because they answer different questions: selectionOffers()
// says what this kind of thing can feed at all, which is the honest answer for a
// menu, while the toolbar shows only what would run right now.

import {
  TOOL_CAPABILITIES,
  applicableTools,
  toolsConsuming,
  type EntityKind,
  type SelectionCounts,
  type ToolId,
} from "../features/toolCapabilities";
import { keyHint } from "../input/shortcuts";

/** Which kind wins when a selection holds several. See the header — this is
 *  app/viewportWiring.ts's drag-handle ranking, and it may not drift from it.
 *
 *  Bodies come last rather than not at all: body selection is a separate mode
 *  (press 2), so in practice it never competes with the other three, and
 *  leaving it off would mean a two-body selection offering nothing while the
 *  booleans sit one keystroke away. */
export const KIND_RANK: readonly EntityKind[] = ["edge", "sketch-region", "face", "body"];

/** Human name for the kind, for a title or a prompt. Singular — callers that
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
  tool: ToolId;
  label: string;
  iconName: string;
  /** The id for the central dispatcher (app/actions.ts), or null for the one
   *  tool that has no such id — see ACTIONLESS below. A caller that cannot
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
 *  because two of them do not match — "delete-face" is drawn by `deleteFace`,
 *  "offset-face" by `offsetFace` — and a convention with exceptions is a
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
  texture: "texture",
  "delete-face": "deleteFace",
  move: "move",
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
 *  It earns its place in the offer anyway — leaving it out would make "what
 *  applies to this face" wrong — so the seam is declared here instead of being
 *  discovered when a click does nothing. */
const ACTIONLESS: ReadonlySet<ToolId> = new Set<ToolId>(["delete-face"]);

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
  const live = new Set(applicableTools(sel));
  return toolsConsuming(kind, "selection").map((tool) => ({
    tool,
    label: TOOL_CAPABILITIES[tool].label,
    iconName: TOOL_ICON[tool],
    action: ACTIONLESS.has(tool) ? null : tool,
    hint: keyHint(tool),
    enabled: live.has(tool),
  }));
}

/** Verbs the hover bar does not carry however applicable they are.
 *
 *  One, and it is destructive. The bar floats over the part, a button-sized
 *  piece of the thing you are looking at, so a stray click lands on geometry
 *  rather than on chrome — which is a poor place to keep "remove this face and
 *  heal the solid". It stays on Del and in the right-click menu.
 *
 *  A named rule rather than the count that used to produce it. The bar stopped
 *  at five buttons because a pie carried the overflow, and Delete Face fell off
 *  the end only because it happens to sort last; with the pie gone the cap has
 *  nothing behind it, and "the sixth offer is dropped" would have quietly
 *  become "whichever offer is sixth is dropped". */
const BAR_EXCLUDED: ReadonlySet<ToolId> = new Set<ToolId>(["delete-face"]);

/** What the floating toolbar shows: every live offer it is willing to carry.
 *
 *  Uncapped. The cap existed because the pie held what the bar trimmed, and
 *  without it a capped bar would put a verb behind a right-click and nothing
 *  else. */
export function toolbarOffers(sel: SelectionCounts): ToolOffer[] {
  return selectionOffers(sel).filter((o) => o.enabled && !BAR_EXCLUDED.has(o.tool));
}
