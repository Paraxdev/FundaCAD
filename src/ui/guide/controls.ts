// The controls guide mode can point at, named by the same refs the agent harness
// uses (docs/HARNESS.md), so an assistant learns one set of names.

import { familyOf, matchName, walkControls, type Control, type WalkOptions } from "../controlRefs";
import { modelRail, sketchRail, type RailEntry } from "../railDefs";

/** One example per id family, for the MCP tool description and the not found text. */
export const REF_FAMILIES: [prefix: string, example: string][] = [
  ["#", "#browser"],
  ["action:", "action:undo"],
  ["family:", "family:cat:MODIFY"],
  ["pick:", "pick:fillet"],
  ["field:", "field:radius"],
  ["prop:", "prop:radius"],
  ["feature:", "feature:f1"],
  ["item:", "item:body1"],
  ["menu:", "menu:File/Open..."],
  ["tab:", "tab:render"],
  ["workspace:", "workspace:model"],
];

export type Resolved =
  | { el: HTMLElement; ref: string; via?: undefined }
  /** Folded away: `el` is what opens it, `via` its ref. */
  | { el: HTMLElement; ref: string; via: string }
  | { el?: undefined; ref: string; via?: undefined; missing: string; near: string[] };

export interface ResolveOptions extends WalkOptions {
  rail?: RailEntry[];
}

const toolName = (ref: string) => ref.replace(/^pick:/, "").replace(/^action:offer:/, "");
const isTool = (ref: string) => ref.startsWith("pick:") || ref.startsWith("action:offer:");

function nearMisses(controls: Control[], ref: string): string[] {
  const kind = ref.includes(":") ? ref.slice(0, ref.indexOf(":") + 1) : ref.slice(0, 1);
  const word = matchName(ref.slice(kind.length).split("/").pop() ?? "");
  const scored = controls
    .map((c) => {
      const name = matchName(c.ref.slice(c.ref.indexOf(":") + 1));
      const label = matchName(c.label);
      let score = 0;
      if (word && (name.includes(word) || label.includes(word))) score += 2;
      if (c.ref.startsWith(kind)) score += 1;
      return { ref: c.ref, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return [...new Set(scored.map((s) => s.ref))].slice(0, 5);
}

/** The visible control a ref names, or what opens it while it is folded away
 *  (a rail tool inside its family, a menu item inside its menu), or near misses. */
export function resolveControl(ref: string, doc: Document = document, opts: ResolveOptions = {}): Resolved {
  const { controls } = walkControls(doc, opts);
  const byRef = (r: string) => controls.find((c) => c.ref === r && !c.disabled) ?? controls.find((c) => c.ref === r);
  const hit = byRef(ref);
  if (hit) return { el: hit.el, ref };
  if (isTool(ref)) {
    const name = toolName(ref);
    const twin = byRef(ref.startsWith("pick:") ? `action:offer:${name}` : `pick:${name}`);
    if (twin) return { el: twin.el, ref: twin.ref };
    const mode = doc.querySelector<HTMLElement>("#toolrail")?.dataset.mode;
    const fam = familyOf(name, opts.rail ?? (mode === "sketch" ? sketchRail() : modelRail()));
    const opener = fam && byRef(fam.family.ref);
    if (opener) return { el: opener.el, ref, via: opener.ref };
  }
  if (ref.startsWith("#")) {
    // A panel such as #browser or #timeline is a place to point at, not a control.
    const el = doc.getElementById(ref.slice(1));
    const r = el && (opts.rect ?? ((e: Element) => e.getBoundingClientRect()))(el);
    if (el && r && (r.width > 0 || r.height > 0) && !el.closest("[inert], .hidden")) return { el, ref };
  }
  const menu = /^menu:([^/]+)\//.exec(ref);
  if (menu) {
    const opener = byRef(`menu:${menu[1]}`);
    if (opener) return { el: opener.el, ref, via: opener.ref };
  }
  const examples = REF_FAMILIES.map(([, e]) => e).join(", ");
  return { ref, missing: `no control "${ref}" on screen, ids look like ${examples}`, near: nearMisses(controls, ref) };
}
