// What to offer for the current selection, for the floating toolbar and the right-click menu's ranking. Built from one
// kind, ranked, not the union. Membership comes from the kind, enablement from the count.

import {
  applicableToolsIn,
  capabilities,
  toolsConsumingIn,
  type AnyToolId,
  type EntityKind,
  type SelectionCounts,
  type ToolCapability,
  type ToolId,
} from "../features/toolCapabilities";
import { contributedToolOwner } from "../plugins/contrib";
import { keyHint } from "../input/shortcuts";
import { t, type MessageKey } from "../i18n";
import { toolLabel } from "./ribbonDefs";

/** Must match app/viewportWiring.ts's drag-handle ranking: the handle and the toolbar are one affordance seen twice.
 *  Bodies come last, not never, so a two-body selection still offers the booleans. */
export const KIND_RANK: readonly EntityKind[] = ["edge", "sketch-region", "face", "body"];

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
  /** Null for the one actionless tool (see ACTIONLESS); a caller that cannot handle null must skip the offer. */
  action: string | null;
  /** Keyboard hint from the single shortcut table, so this can never advertise
   *  a key the keymap does not bind. */
  hint: string | undefined;
  /** The selection actually satisfies this tool's minimum. */
  enabled: boolean;
  /** The plugin that contributed this tool, or undefined for an app tool. What
   *  the rail groups a plugin's tools under its own heading by. */
  pluginId: string | undefined;
}

/** A table, not string surgery: "delete-face" draws `deleteFace` and "offset-face" `offsetFace`.
 *  selectionTools.test.ts holds every tool to an entry. */
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
  "pattern-rect": "patternRect",
  mirror: "mirror",
  "boolean-union": "booleanUnion",
  "boolean-subtract": "booleanSubtract",
  "boolean-intersect": "booleanIntersect",
  measure: "measure",
  shell: "shell",
  draft: "draft",
  "offset-face": "offsetFace",
  thicken: "thicken",
  thread: "thread",
  "text-on-face": "text",
  hole: "hole",
};

/** Face delete goes through engine.deleteSelectedFace as a selection verb (see features/toolCapabilities.ts), but it
 *  still belongs in what applies to a face, so the seam is declared here. */
const ACTIONLESS: ReadonlySet<string> = new Set<string>(["delete-face"]);

// A plugin tool keeps its own words; Delete Face is never drawn, so it has no key.
function offerLabel(tool: AnyToolId, cap: ToolCapability): string {
  return Object.hasOwn(TOOL_ICON, tool) ? (toolLabel(tool) ?? cap.label) : cap.label;
}

/** The app table first, as two app tools are named apart from their id; a contributed tool answers from its own
 *  capability row. */
function iconFor(tool: AnyToolId, declared: string | undefined): string {
  return TOOL_ICON[tool as ToolId] ?? declared ?? "dot";
}

/** Every tool the selection's winning kind can feed, in the capability table's
 *  own preference order, each marked live or not. Empty for an empty
 *  selection. */
export function selectionOffers(sel: SelectionCounts): ToolOffer[] {
  const kind = primaryKind(sel);
  if (!kind) return [];
  // applicableTools() is the authority on each tool's minimum. One inventory snapshot, so a plugin switching off
  // mid-call cannot mismatch the enabled flags and the rows.
  const caps = capabilities();
  const live = new Set(applicableToolsIn(caps, sel));
  return toolsConsumingIn(caps, kind, "selection").map((tool) => {
    const cap = caps.get(tool)!;
    return {
      tool,
      label: offerLabel(tool, cap),
      iconName: iconFor(tool, cap.icon),
      action: ACTIONLESS.has(tool) ? null : tool,
      hint: keyHint(tool),
      enabled: live.has(tool),
      pluginId: contributedToolOwner(tool) ?? undefined,
    };
  });
}

/** Destructive verbs stay off the hover bar, which floats over the geometry where stray clicks land; Delete Face stays
 *  on Del and the right-click menu. */
const BAR_EXCLUDED: ReadonlySet<string> = new Set<string>(["delete-face"]);

/** Every live offer it will carry, uncapped. */
export function toolbarOffers(sel: SelectionCounts): ToolOffer[] {
  const base = selectionOffers(sel).filter((o) => o.enabled && !BAR_EXCLUDED.has(o.tool));
  return primaryKind(sel) === "body" ? [...bodyEdgeToolOffers(), ...base] : base;
}

/** Fillet and Chamfer stay offered for a whole body, as either tool then asks for an edge (edgeFeatureTool.start).
 *  Kept out of the capability table so selectionOffers()'s body answer stays honest. */
function bodyEdgeToolOffers(): ToolOffer[] {
  const caps = capabilities();
  return (["fillet", "chamfer"] as const).map((tool) => {
    const cap = caps.get(tool)!;
    return {
      tool,
      label: offerLabel(tool, cap),
      iconName: iconFor(tool, cap.icon),
      action: tool,
      hint: keyHint(tool),
      enabled: true,
      pluginId: undefined,
    };
  });
}

// Appearance verbs write display-only overlays, not features, so they stay out of features/toolCapabilities.ts and
// applicableTools().

/** The appearance verbs, by id. Not action strings: none of these is a command
 *  the ribbon dispatches, each is a direct write the surface performs. */
export type AppearanceId = "material" | "hide" | "isolate";

export interface AppearanceOffer {
  id: AppearanceId;
  label: string;
  iconName: string;
}

/** Bodies only, and only when bodies are the preferred kind: "Hide" beside a picked face is ambiguous. Empty otherwise,
 *  which tells the bar whether to draw a divider. */
export function appearanceOffers(sel: SelectionCounts): AppearanceOffer[] {
  if (primaryKind(sel) !== "body") return [];
  const n = sel.body ?? 0;
  return [
    // Material first: it is the one that is not about visibility, and it is the one this bar was asked for.
    { id: "material", label: t("rail.look.material", { n }), iconName: "material" },
    { id: "hide", label: t("rail.look.hide", { n }), iconName: "hidden" },
    { id: "isolate", label: t("rail.look.isolate", { n }), iconName: "isolate" },
  ];
}

const COUNT_KEYS: Record<EntityKind, MessageKey> = {
  edge: "rail.count.edge",
  face: "rail.count.face",
  vertex: "rail.count.corner",
  body: "rail.count.body",
  "sketch-region": "rail.count.profile",
};

export const countLine = (kind: EntityKind, n: number): string => t(COUNT_KEYS[kind], { n });

/** "3 faces" in the chosen language, empty for an empty selection. */
export function selectionCountText(sel: SelectionCounts): string {
  const kind = primaryKind(sel);
  return kind ? countLine(kind, sel[kind] ?? 0) : "";
}
