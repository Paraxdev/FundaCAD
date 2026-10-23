// What a guide wait listens for: a few facts about the window, compared between
// frames, so a wait only counts what happened after it was armed.

import { matchName } from "../controlRefs";

export interface Snapshot {
  /** The running tool's name as its button reads, or null. */
  tool: string | null;
  features: { id: string; type: string }[];
  selection: { faces: number; edges: number; bodies: number };
  /** The value box field being typed in and its text; `typed` is false while it
   *  still shows the tool's own default. */
  value: { field: string; text: string; typed: boolean } | null;
}

export type GuideEvent =
  | { kind: "tool"; tool: string }
  | { kind: "feature"; id: string; type: string }
  | { kind: "selection"; faces: number; edges: number; bodies: number }
  | { kind: "value"; field: string; text: string }
  | { kind: "next" };

export const WAIT_KINDS = ["next", "tool", "feature", "selection", "value"] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

export interface WaitSpec {
  until: WaitKind[];
  tool?: string | undefined;
  field?: string | undefined;
}

export const emptySnapshot = (): Snapshot => ({
  tool: null,
  features: [],
  selection: { faces: 0, edges: 0, bodies: 0 },
  value: null,
});

export function diffSnapshot(prev: Snapshot, next: Snapshot): GuideEvent[] {
  const out: GuideEvent[] = [];
  if (next.tool && next.tool !== prev.tool) out.push({ kind: "tool", tool: next.tool });
  const had = new Set(prev.features.map((f) => f.id));
  for (const f of next.features) if (!had.has(f.id)) out.push({ kind: "feature", id: f.id, type: f.type });
  const a = prev.selection,
    b = next.selection;
  const picked = b.faces + b.edges + b.bodies;
  if (picked > 0 && (a.faces !== b.faces || a.edges !== b.edges || a.bodies !== b.bodies))
    out.push({ kind: "selection", ...b });
  const v = next.value;
  if (v?.typed && v.text !== "" && (v.field !== prev.value?.field || v.text !== prev.value.text || !prev.value.typed)) {
    out.push({ kind: "value", field: v.field, text: v.text });
  }
  return out;
}

const named = (have: string, want: string) => {
  const h = matchName(have),
    w = matchName(want);
  return h === w || h.startsWith(w) || h.split(/[^a-z0-9]+/).includes(w);
};

export function matchWait(wait: WaitSpec, ev: GuideEvent): boolean {
  if (!wait.until.includes(ev.kind)) return false;
  if (ev.kind === "tool" && wait.tool) return named(ev.tool, wait.tool);
  if (ev.kind === "feature" && wait.tool) return named(ev.type, wait.tool);
  if (ev.kind === "value" && wait.field) return matchName(ev.field) === matchName(wait.field);
  return true;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** One line for the assistant. */
export function describeEvent(ev: GuideEvent): string {
  switch (ev.kind) {
    case "next":
      return "Next pressed";
    case "tool":
      return `tool started: ${ev.tool}`;
    case "feature":
      return `feature added: ${ev.id} (${ev.type})`;
    case "value":
      return `value typed: ${ev.field} = ${ev.text}`;
    case "selection": {
      const parts = [
        ev.faces && plural(ev.faces, "face"),
        ev.edges && plural(ev.edges, "edge"),
        ev.bodies && plural(ev.bodies, "body"),
      ].filter(Boolean);
      return `selection: ${parts.join(", ").replace(/bodys/, "bodies")}`;
    }
  }
}
