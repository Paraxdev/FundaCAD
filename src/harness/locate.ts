// Finding the control a harness call names, by ref or by the label a person
// reads, and marking it so the Python side clicks it through Playwright.

import { modelRail, sketchRail, type RailEntry } from "../ui/railDefs";
import { familyOf, matchName, type Control, type Walk } from "./screenTree";

export class HarnessError extends Error {
  constructor(
    message: string,
    readonly kind: "NotFound" | "Ambiguous" | "Disabled" | "Occluded" | "SettleTimeout" | "BadArgs",
    readonly candidates: string[] = [],
  ) {
    super(message);
  }
}

const REF = /^(#|(action|family|pick|group|feature|item|folder|eye|field|prop|testid|tab|workspace|view-mode|category|menu|ctx|choice|opt|text):)/;

export const isRef = (target: string) => REF.test(target);

const describe = (c: Control) => `${c.ref} "${c.label}"`;

const words = (s: string) => s.split(/[\s:/._#"-]+/).filter(Boolean);

function sharedStart(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function nearMisses(walk: Walk, target: string): string[] {
  const menu = /^menu:([^/]+)\//.exec(target);
  const items = menu ? walk.controls.filter((c) => c.ref.startsWith(`menu:${menu[1]}/`)) : [];
  if (items.length) return items.slice(0, 8).map(describe);
  const kind = /^(field|prop):/.exec(target)?.[0];
  const same = kind ? walk.controls.filter((c) => c.ref.startsWith(kind)) : [];
  const want = matchName(target.replace(REF, ""));
  if (!want) return [];
  const close = Math.max(3, Math.ceil(want.length / 2));
  const scored = walk.controls
    .map((c) => {
      const name = matchName(c.label);
      const starts = [name, ...words(name), ...words(c.ref.toLowerCase())].some((w) => w.startsWith(want));
      const score = starts ? 3
        : sharedStart(name, want) >= close ? 2
          : want.includes(name) && name.length > 2 ? 1 : 0;
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { c } of scored) {
    if (seen.has(c.ref)) continue;
    seen.add(c.ref);
    out.push(describe(c));
    if (out.length === 8) break;
  }
  return out.length ? out : same.slice(0, 8).map(describe);
}

/** Said when a value field is wanted and none is on screen. */
export function noValueBox(walk: Walk): string {
  return walk.controls.some((c) => c.ref.startsWith("field:"))
    ? ""
    : ", no value box is open, the tool may still be waiting for a pick";
}

function pickOne(matches: Control[], target: string, walk: Walk, index: number | null, anyState = false): Control {
  if (index != null) {
    const hit = matches[index - 1];
    if (!hit) throw new HarnessError(`no control "${target}" number ${index}, there are ${matches.length}`, "NotFound", matches.map(describe));
    return hit;
  }
  const enabled = anyState ? matches : matches.filter((c) => !c.disabled);
  if (enabled.length === 1) return enabled[0]!;
  if (enabled.length > 1) {
    const refs = new Set(enabled.map((c) => c.ref));
    const list = refs.size === 1 ? enabled.map((c, i) => `${c.ref}#${i + 1} "${c.label}"`) : enabled.map(describe);
    throw new HarnessError(`"${target}" matches ${enabled.length} controls: ${list.slice(0, 8).join(", ")}`, "Ambiguous", list.slice(0, 8));
  }
  if (matches.length) throw new HarnessError(`${describe(matches[0]!)} is disabled`, "Disabled", matches.map(describe));
  const related = walk.controls.find((c) => c.ref === "testid:history-related" && c.flags.includes("on"));
  if (related && target.startsWith("feature:")) {
    throw new HarnessError(
      `no visible control "${target}", History shows only what relates to the selection, press Escape to clear the selection or click ${related.ref}`,
      "NotFound",
      [describe(related)],
    );
  }
  const near = nearMisses(walk, target);
  const box = target.startsWith("field:") ? noValueBox(walk) : "";
  throw new HarnessError(
    `no visible control "${target}"${box}${near.length ? `: did you mean ${near.join(", ")}` : ""}`,
    "NotFound",
    near,
  );
}

/** The control a ref or label names. A trailing `#n` picks the n-th of several. */
export function findControl(walk: Walk, target: string, opts: { disabled?: boolean } = {}): Control {
  const m = /^(.+?)#(\d+)$/.exec(target);
  const base = m ? m[1]! : target;
  const index = m ? Number(m[2]) : null;
  const any = opts.disabled === true;
  if (isRef(base)) {
    return pickOne(walk.controls.filter((c) => c.ref === base), base, walk, index, any);
  }
  const want = matchName(base);
  if (!want) throw new HarnessError("an empty label names nothing", "BadArgs");
  const named = walk.controls.filter((c) => c.role !== "eye");
  const exact = named.filter((c) => matchName(c.label) === want);
  if (exact.length) return pickOne(exact, base, walk, index, any);
  const prefix = named.filter((c) => matchName(c.label).startsWith(want));
  return pickOne(prefix, base, walk, index, any);
}

let stamped: Element | null = null;
let stampSeq = 0;

/** Marks one element for the Python side's locator; the previous mark goes. */
export function stamp(el: Element): string {
  stamped?.removeAttribute("data-harness-target");
  stamped = el;
  const id = String(++stampSeq);
  el.setAttribute("data-harness-target", id);
  return id;
}

/** Something else is drawn over the middle of the element. */
export function covered(el: Element, doc: Document = document): boolean {
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return false;
  const top = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!top && top !== el && !el.contains(top) && !top.contains(el);
}

export interface ToolStep {
  ref: string;
  button: "left" | "right";
}

/** The clicks that reach a rail tool: its category or variant family first
 *  when the tool is folded inside one. */
export function toolPath(walk: Walk, label: string, mode: string, defs?: RailEntry[]): ToolStep[] {
  const rail = { ...walk, controls: walk.controls.filter((c) => c.region === "toolrail") };
  try {
    return [{ ref: findControl(rail, label).ref, button: "left" }];
  } catch (err) {
    if (!(err instanceof HarnessError) || err.kind !== "NotFound") throw err;
    const entries = defs ?? (mode === "sketch" ? sketchRail() : modelRail());
    const hit = familyOf(label, entries);
    if (hit) return [hit.family, { ref: hit.pick, button: "left" }];
    const families = rail.controls.filter((c) => c.ref.startsWith("family:"));
    throw new HarnessError(
      `no tool "${label}" in the rail: click a family to list its tools (${families.map(describe).join(", ")}),`
        + " a tool's own choices, such as the shapes of Primitive, show once it starts",
      "NotFound",
      families.map(describe),
    );
  }
}
