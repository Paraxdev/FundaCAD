// The single inventory of what each modeling tool can ACT ON: the kinds of entity a
// tool consumes and, read the other way, which tools a selection can feed.
//
//   consumedKinds("fillet")      -> what can this tool consume?
//   applicableTools({face: 1})   -> given this selection, which tools apply?
//
// Same shape as document/numFields.ts and for the same reason. The answer used to
// be spread across four readers that each re-derived it, the handle ranking in
// app/viewportWiring.ts, the context-menu enable rules, the "select a face first"
// refusals inside each starter, and the tools themselves, and they disagreed: a
// face selection offered Press/Pull and nothing else, while Fillet, which can
// perfectly well round every edge of that face, needed the edges re-picked by hand.
//
// A capability model, not a dispatcher: it says a face COULD feed Fillet, never how
// Fillet gets from a face to the edges it blends, and never whether the document is
// in a state where the command would succeed.
//
// NOT EVERY TOOL IS IN THIS FILE. A plugin contributes tools too, and a
// contributed one has to be a peer of the app's own or it is not a tool at all:
// selecting a face has to offer it beside Fillet and Press/Pull, and the
// selection toolbar has to draw its mark. So the inventory below is the app's
// HALF of the answer, and `capabilities()` is the whole of it.
//
// The split that keeps this testable is pure-from-impure, in the shape this
// repository uses everywhere: the four questions are answered by functions over
// a table they are HANDED (`...In`), and the exported one-liners are the ones
// that go and fetch the merged table. The rules are then testable against a
// table a test wrote, with no plugin registered and nothing to reset.

import { contributedTools } from "../plugins/contrib";

/** The kinds of thing a selection can hold.
 *
 *  "vertex" is here ahead of its picker: nothing in the viewport selects a
 *  corner yet, so no tool declares it and `toolsConsuming("vertex")` is
 *  legitimately empty. It is in the union because the alternative, adding the
 *  kind at the same time as the first tool that wants it, is what turns a
 *  capability table into a rename. */
export type EntityKind = "face" | "edge" | "vertex" | "body" | "sketch-region";

/** How a tool gets hold of its entities.
 *
 *  "selection" tools consume what is already selected: pressing the key acts on
 *  it immediately. "pick" tools run their own modal pick (see
 *  featureStarters.pickFaceInteractive) and ignore the ambient selection
 *  entirely, Shell can act on a face, but a selected face does not make Shell
 *  runnable without a further click. Only "selection" tools can answer
 *  applicableTools(), which is the distinction the ambient affordances need and
 *  the one an `acts on a face` list alone would blur. */
export type EntitySource = "selection" | "pick";

/** Stable ids for the tools THE APP ITSELF has.
 *
 *  These match the action strings app/actions.ts dispatches, so a caller that
 *  learns a tool applies can run it, with one deliberate exception noted on
 *  "delete-face" below.
 *
 *  A contributed tool's id is not in this union and cannot be: it is a string
 *  from a bundle this build has never seen. Everything downstream therefore
 *  takes a `string`, and the union survives as what it always was, the thing
 *  that makes TOOL_CAPABILITIES below exhaustive over the app's own tools, so
 *  adding one and forgetting its row is a compile error. */
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
  | "boolean-union"
  | "boolean-subtract"
  | "boolean-intersect"
  | "measure"
  | "shell"
  | "draft"
  | "offset-face"
  | "thicken"
  | "thread";

export interface ToolCapability {
  /** Human name, for prompts and menus. */
  label: string;
  /** Entity kinds this tool can act on, MOST SPECIFIC FIRST. The order is the
   *  tool's own preference when a selection holds several kinds at once: Extrude
   *  lists the profile before the face because a visible sketch outranks the
   *  solid under it (see featureStarters.startExtrude, which arbitrates exactly
   *  that way). */
  consumes: readonly EntityKind[];
  source: EntitySource;
  /** How many entities of a consumed kind the tool needs before it can run.
   *  Defaults to 1; a boolean needs two bodies and Loft two profiles to sweep
   *  between, and offering either off a single pick is an offer that cannot be
   *  taken. */
  min?: number;
  /** Icon name, for a CONTRIBUTED tool only.
   *
   *  The app's own tools are drawn from the table in ui/selectionTools.ts,
   *  which exists because two of them have an icon name that is not their id
   *  and a convention with exceptions fails silently. A contributed tool has no
   *  such history to carry, so it says its own name here and there is nothing
   *  to keep in step. */
  icon?: string;
}

/** The inventory. Declaration order is the order answers are offered: a
 *  selection that feeds several tools lists them in this order, so the entry
 *  nearest the top is the one an affordance should default to. */
export const TOOL_CAPABILITIES: Record<ToolId, ToolCapability> = {
  // Fillet and chamfer take EDGES, and a face is shorthand for "every edge of
  // this face", the same blend, named by the region it surrounds rather than
  // by twelve individual picks. edgeFeatureTool.start() is what expands it.
  fillet: { label: "Fillet", consumes: ["edge", "face"], source: "selection" },
  chamfer: { label: "Chamfer", consumes: ["edge", "face"], source: "selection" },
  presspull: { label: "Press/Pull", consumes: ["face"], source: "selection" },
  // Extrude arbitrates profile-over-face itself; see the note on `consumes`.
  extrude: { label: "Extrude", consumes: ["sketch-region", "face"], source: "selection" },
  revolve: { label: "Revolve", consumes: ["sketch-region"], source: "selection" },
  sweep: { label: "Sweep", consumes: ["sketch-region"], source: "selection" },
  loft: { label: "Loft", consumes: ["sketch-region"], source: "selection", min: 2 },
  // The one id that is not an action string: face delete is dispatched through
  // engine.deleteSelectedFace (the Del key and the face context menu), because
  // it is a selection verb rather than a command with a ribbon button. It earns
  // its row anyway, leaving it out would make "what applies to this face"
  // wrong, which is the only question this table exists to answer.
  "delete-face": { label: "Delete Face", consumes: ["face"], source: "selection" },
  move: { label: "Move", consumes: ["body"], source: "selection" },
  // The two patterns, on the same rule as Move: they repeat the SELECTED
  // bodies, falling back to the active one when nothing is picked (see
  // featureStarters.startPattern). They were reachable only from the ribbon
  // while every other body verb was offered on the selection itself, so a
  // picked part was one click from a boolean and a menu hunt from a pattern.
  //
  // Two rows, not one: linear and circular are different gestures, pull an
  // arrow along an axis or sweep around one, which is why the ribbon splits
  // them too. Collapsing them here would offer a button that has to ask.
  "pattern-linear": { label: "Linear Pattern", consumes: ["body"], source: "selection" },
  "pattern-circular": { label: "Circular Pattern", consumes: ["body"], source: "selection" },
  // The three booleans, each a command in its own right. One "Combine" entry
  // that opened a dialog would put a two-body selection one click from a
  // question instead of one click from an answer, which is the whole reason
  // there are three of them (features/booleanOps.ts). The FIRST selected body is
  // the one kept, so Subtract has a direction without asking for one.
  "boolean-union": { label: "Union", consumes: ["body"], source: "selection", min: 2 },
  "boolean-subtract": { label: "Subtract", consumes: ["body"], source: "selection", min: 2 },
  "boolean-intersect": { label: "Intersect", consumes: ["body"], source: "selection", min: 2 },
  // --- tools that run their own pick; the ambient selection is not consumed ---
  measure: { label: "Measure", consumes: ["face", "edge"], source: "pick" },
  shell: { label: "Shell", consumes: ["face"], source: "pick" },
  draft: { label: "Draft", consumes: ["face"], source: "pick" },
  "offset-face": { label: "Offset Face", consumes: ["face"], source: "pick" },
  thicken: { label: "Thicken", consumes: ["face"], source: "pick" },
  // Thread takes a ROUND face specifically; the table has no kind for "a face
  // that happens to be a cylinder", and inventing one to describe a single
  // tool's refusal would be describing the tool, not the selection. The tool
  // says so itself when the face it is handed is flat.
  thread: { label: "Thread", consumes: ["face"], source: "pick" },
};

/** Every tool id THE APP ITSELF has, in inventory order. */
export const TOOL_IDS = Object.keys(TOOL_CAPABILITIES) as ToolId[];

/** Any tool id: one of the app's own, or a string from a plugin. */
export type AnyToolId = ToolId | (string & {});

/** An inventory: tool id -> what it can act on, in offer order. */
export type Capabilities = ReadonlyMap<string, ToolCapability>;

/** The app's own tools as a map, so the pure functions below take one shape
 *  whether the caller merged anything in or not. */
export function coreCapabilities(): Capabilities {
  return new Map(TOOL_IDS.map((id) => [id as string, TOOL_CAPABILITIES[id]]));
}

/** The app's tools, then whatever is contributed.
 *
 *  App-first is the offer order and it is deliberate: a selection that feeds
 *  both lists Press/Pull before a plugin's tool, because the app's own verbs
 *  are the ones somebody expects to be where they were yesterday. A plugin
 *  cannot displace one by claiming its id either, an id already in the map is
 *  kept, so the worst a colliding plugin achieves is a button of its own that
 *  runs the app's tool, rather than a Fillet that quietly does something else.
 *
 *  Rebuilt per call rather than cached: what is contributed changes when a
 *  plugin is switched off, and this is asked at click time, not per frame. */
export function capabilities(): Capabilities {
  const merged = new Map(coreCapabilities());
  for (const t of contributedTools()) {
    if (merged.has(t.id)) continue;
    merged.set(t.id, {
      label: t.label,
      consumes: t.consumes,
      source: t.source,
      ...(t.min !== undefined ? { min: t.min } : {}),
      icon: t.iconName,
    });
  }
  return merged;
}

/** What one tool can act on, or null when nothing has that id. */
export function capabilityOf(tool: AnyToolId): ToolCapability | null {
  return capabilities().get(tool) ?? null;
}

/** What this tool can consume. Empty for a tool nothing has declared, which is
 *  the same answer as "it consumes nothing" and is what every caller wants: a
 *  tool from a plugin that has just been switched off should offer nothing, not
 *  throw inside a context menu. */
export function consumedKinds(tool: AnyToolId): readonly EntityKind[] {
  return capabilityOf(tool)?.consumes ?? [];
}

/** Can this tool act on that kind of entity at all? The guard a tool uses before
 *  reaching for a selection it does not normally take, Fillet asks this before
 *  expanding a face into its edges, so the behaviour and the table can never
 *  drift apart. */
export function canConsume(tool: AnyToolId, kind: EntityKind): boolean {
  return consumedKinds(tool).includes(kind);
}

/** How many entities `tool` needs before it can run. */
export function minimumCount(tool: AnyToolId): number {
  return capabilityOf(tool)?.min ?? 1;
}

/** Every tool that can act on `kind`, inventory order.
 *
 *  `source` narrows it to one half of the table: pass "selection" for "what
 *  could I do with what is selected", and leave it off for the honest full
 *  answer to "what acts on faces at all". */
export function toolsConsumingIn(
  caps: Capabilities,
  kind: EntityKind,
  source?: EntitySource,
): string[] {
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

/** How many of each kind are currently selected. Absent === none. */
export type SelectionCounts = Partial<Record<EntityKind, number>>;

/** The tools this selection can feed, inventory order, the first is what an
 *  affordance should offer by default.
 *
 *  A tool qualifies when the selection holds at least `min` of ANY kind it
 *  consumes. Tools that run their own pick never qualify however much is
 *  selected: they would ignore it. */
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

/** Which kind of the selection a tool would actually take, or null when it can
 *  take none of it, the tool's own preference order (see `consumes`) decides,
 *  so a face selected under a visible profile hands Extrude the profile and
 *  Press/Pull the face, from the same counts. */
export function consumedKindOf(tool: AnyToolId, sel: SelectionCounts): EntityKind | null {
  const cap = capabilityOf(tool);
  if (!cap) return null;
  const need = cap.min ?? 1;
  return cap.consumes.find((kind) => (sel[kind] ?? 0) >= need) ?? null;
}
