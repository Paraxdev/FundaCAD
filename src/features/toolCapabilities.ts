// What each modeling tool can act on, never how it gets there or whether it would succeed.
// TOOL_CAPABILITIES is the app's half and `capabilities()` merges in plugin tools; the `...In`
// forms take the table as an argument so tests need no plugin registered.

import { t, type MessageKey } from "../i18n";
import { contributedTools } from "../plugins/contrib";

/** "vertex" is ahead of its picker: no tool declares it yet, so `toolsConsuming("vertex")` is empty. */
export type EntityKind = "face" | "edge" | "vertex" | "body" | "sketch-region";

/** "selection" tools act on what is selected; "pick" tools run their own modal pick and ignore the
 *  selection, so only "selection" tools show up in applicableTools(). */
export type EntitySource = "selection" | "pick";

/** The app's own tools, matching the action strings app/actions.ts dispatches except "delete-face".
 *  Plugin ids are plain strings; this union only makes TOOL_CAPABILITIES exhaustive. */
export type ToolId =
  | "fillet"
  | "chamfer"
  | "presspull"
  | "extrude"
  | "revolve"
  | "sweep"
  | "loft"
  | "delete-face"
  | "move"
  | "pattern-linear"
  | "pattern-circular"
  | "pattern-rect"
  | "mirror"
  | "boolean-union"
  | "boolean-subtract"
  | "boolean-intersect"
  | "measure"
  | "shell"
  | "draft"
  | "offset-face"
  | "thicken"
  | "thread"
  | "text-on-face"
  | "hole";

export interface ToolCapability {
  readonly label: string;
  /** Most specific first: the order breaks ties when a selection holds several kinds, so Extrude
   *  takes a visible profile over the solid face under it (featureStarters.startExtrude). */
  consumes: readonly EntityKind[];
  source: EntitySource;
  /** Defaults to 1; a boolean needs two bodies and Loft two profiles. */
  min?: number;
  /** Contributed tools only; the app's own icons come from ui/selectionTools.ts, as two differ from their id. */
  icon?: string;
}

// A getter, so the label follows a language switch.
function cap(labelKey: MessageKey, rest: Omit<ToolCapability, "label">): ToolCapability {
  return {
    ...rest,
    get label() {
      return t(labelKey);
    },
  };
}

/** Declaration order is offer order: the first tool a selection feeds is the affordance default. */
export const TOOL_CAPABILITIES: Record<ToolId, ToolCapability> = {
  // A face is shorthand for every edge of it; edgeFeatureTool.start() expands it.
  fillet: cap("tool.fillet", { consumes: ["edge", "face"], source: "selection" }),
  chamfer: cap("tool.chamfer", { consumes: ["edge", "face"], source: "selection" }),
  presspull: cap("tool.pressPull", { consumes: ["face"], source: "selection" }),
  extrude: cap("tool.extrude", { consumes: ["sketch-region", "face"], source: "selection" }),
  revolve: cap("tool.revolve", { consumes: ["sketch-region"], source: "selection" }),
  sweep: cap("tool.sweep", { consumes: ["sketch-region"], source: "selection" }),
  loft: cap("tool.loft", { consumes: ["sketch-region"], source: "selection", min: 2 }),
  // Not an action string: it goes through engine.deleteSelectedFace (Del key, face context menu),
  // but leaving it out would make "what applies to this face" wrong.
  "delete-face": cap("feature.deleteFace", { consumes: ["face"], source: "selection" }),
  move: cap("tool.move", { consumes: ["body", "sketch-region"], source: "selection" }),
  // Patterns repeat the selected bodies, else the active one. A face stands for the feature
  // that made it, so a hole's wall patterns the hole (features/patternSources.ts).
  "pattern-linear": cap("tool.linearPattern", { consumes: ["body", "face"], source: "selection" }),
  "pattern-circular": cap("tool.circularPattern", { consumes: ["body", "face"], source: "selection" }),
  "pattern-rect": cap("tool.rectPattern", { consumes: ["body", "face"], source: "selection" }),
  mirror: cap("tool.mirror", { consumes: ["body"], source: "selection" }),
  // The first selected body is the one kept, so Subtract has a direction without asking.
  "boolean-union": cap("tool.union", { consumes: ["body"], source: "selection", min: 2 }),
  "boolean-subtract": cap("tool.subtract", { consumes: ["body"], source: "selection", min: 2 }),
  "boolean-intersect": cap("tool.intersect", { consumes: ["body"], source: "selection", min: 2 }),
  shell: cap("tool.shell", { consumes: ["face"], source: "selection" }),
  draft: cap("tool.draft", { consumes: ["face"], source: "selection" }),
  "offset-face": cap("tool.offsetFace", { consumes: ["face"], source: "selection" }),
  // The selected face is where the first hole goes; further clicks add more.
  hole: cap("tool.hole", { consumes: ["face"], source: "selection" }),
  measure: cap("tool.measure", { consumes: ["face", "edge"], source: "pick" }),
  thicken: cap("tool.thicken", { consumes: ["face"], source: "pick" }),
  // Thread needs a round face, which no kind describes; the tool refuses a flat one itself.
  thread: cap("tool.thread", { consumes: ["face"], source: "pick" }),
  "text-on-face": cap("tool.textOnFace", { consumes: ["face"], source: "pick" }),
};

export const TOOL_IDS = Object.keys(TOOL_CAPABILITIES) as ToolId[];

export type AnyToolId = ToolId | (string & {});

export type Capabilities = ReadonlyMap<string, ToolCapability>;

export function coreCapabilities(): Capabilities {
  return new Map(TOOL_IDS.map((id) => [id as string, TOOL_CAPABILITIES[id]]));
}

/** App tools first so they stay where people expect, and a plugin cannot displace one by claiming its id.
 *  Rebuilt per call, not cached: a plugin can be switched off, and this is asked per click, not per frame. */
export function capabilities(): Capabilities {
  const merged = new Map(coreCapabilities());
  for (const tool of contributedTools()) {
    if (merged.has(tool.id)) continue;
    merged.set(tool.id, {
      label: tool.label,
      consumes: tool.consumes,
      source: tool.source,
      ...(tool.min !== undefined ? { min: tool.min } : {}),
      icon: tool.iconName,
    });
  }
  return merged;
}

export function capabilityOf(tool: AnyToolId): ToolCapability | null {
  return capabilities().get(tool) ?? null;
}

/** Empty for an unknown tool, so a plugin tool just switched off offers nothing rather than throwing. */
export function consumedKinds(tool: AnyToolId): readonly EntityKind[] {
  return capabilityOf(tool)?.consumes ?? [];
}

/** Fillet asks this before expanding a face into its edges, so behaviour and table never drift apart. */
export function canConsume(tool: AnyToolId, kind: EntityKind): boolean {
  return consumedKinds(tool).includes(kind);
}

export function minimumCount(tool: AnyToolId): number {
  return capabilityOf(tool)?.min ?? 1;
}

/** `source` "selection" answers what the selection could do; left off, what acts on that kind at all. */
export function toolsConsumingIn(caps: Capabilities, kind: EntityKind, source?: EntitySource): string[] {
  const out: string[] = [];
  for (const [id, cap] of caps) {
    if (source && cap.source !== source) continue;
    if (cap.consumes.includes(kind)) out.push(id);
  }
  return out;
}

export function toolsConsuming(kind: EntityKind, source?: EntitySource): string[] {
  return toolsConsumingIn(capabilities(), kind, source);
}

export type SelectionCounts = Partial<Record<EntityKind, number>>;

/** A tool qualifies with at least `min` of any kind it consumes; pick tools never do, they would ignore it. */
export function applicableToolsIn(caps: Capabilities, sel: SelectionCounts): string[] {
  const out: string[] = [];
  for (const [id, cap] of caps) {
    if (cap.source !== "selection") continue;
    const need = cap.min ?? 1;
    if (cap.consumes.some((kind) => (sel[kind] ?? 0) >= need)) out.push(id);
  }
  return out;
}

export function applicableTools(sel: SelectionCounts): string[] {
  return applicableToolsIn(capabilities(), sel);
}

/** The `consumes` order decides, so a face under a visible profile hands Extrude the profile
 *  and Press/Pull the face, from the same counts. */
export function consumedKindOf(tool: AnyToolId, sel: SelectionCounts): EntityKind | null {
  const cap = capabilityOf(tool);
  if (!cap) return null;
  const need = cap.min ?? 1;
  return cap.consumes.find((kind) => (sel[kind] ?? 0) >= need) ?? null;
}
