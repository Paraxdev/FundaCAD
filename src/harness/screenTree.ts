// What is on screen, as the agent harness reads it: every visible control with
// a ref that stays stable across label rewording (see docs/HARNESS.md).

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WalkOptions {
  /** Where an element is on screen. happy-dom lays nothing out, so tests pass one. */
  rect?: (el: Element) => Box;
}

export interface Control {
  el: HTMLElement;
  ref: string;
  role: string;
  label: string;
  flags: string[];
  region: string;
  disabled: boolean;
}

export type Line = [depth: number, ref: string, role: string, label: string, flags: string[]];

export const REGIONS = [
  "titlebar", "menu", "toolrail", "history", "props", "items", "valuebox",
  "dialog", "context", "render", "views", "status", "other",
] as const;

const CONTROL = [
  "button", "input", "select", "textarea", "a[href]",
  "[role=tab]", "[role=button]", "[role=menuitem]", "[role=switch]", "[role=radio]",
  ".ctx-item", ".cmdk-item", ".timeline-node", ".feature-row", ".tree-folder", ".tree-eye", ".opt-row",
  "#docname", "#prompt", "[data-testid=selection-readout]",
].join(",");

const TEXT_ONLY = "#docname, #prompt, [data-testid=selection-readout]";
const LABEL_NOISE = ".menu-shortcut, .ctx-key, .cmdk-key, .menu-check, .dirty-mark, .t-caret, .tree-count";
const MAX_LABEL = 60;

const realRect = (el: Element): Box => el.getBoundingClientRect();

/** Text a person reads on the element, without key hints and markers. */
export function visibleText(el: Element): string {
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === 3) out += n.textContent ?? "";
    else if (n instanceof Element && !n.matches(LABEL_NOISE)) n.childNodes.forEach(walk);
  };
  walk(el);
  return out.replace(/\s+/g, " ").trim();
}

function clip(s: string): string {
  return s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 3)}...` : s;
}

export function labelOf(el: HTMLElement): string {
  const row = el.matches(".tree-eye") ? el.closest<HTMLElement>(".feature-row, .tree-folder") : null;
  if (row) return labelOf(row);
  const own = el.querySelector(":scope .t-name, :scope .tree-label, :scope .ctx-label, :scope .cmdk-label");
  if (own && el.matches(".timeline-node, .feature-row, .tree-folder, .ctx-item, .cmdk-item")) return clip(visibleText(own));
  const aria = el.getAttribute("aria-label");
  if (aria) return clip(aria.trim());
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const p = el.getAttribute("placeholder");
    if (p) return clip(p);
    const lab = el.closest("label") ?? el.closest(".param-row")?.querySelector("label");
    if (lab) return clip(visibleText(lab));
    return clip(el.getAttribute("title") ?? "");
  }
  const text = visibleText(el);
  return clip(text || (el.getAttribute("title") ?? "").trim());
}

/** The name a label is matched by: no trailing "(keys)", no case. */
export function matchName(label: string): string {
  return label.replace(/\s*\([^()]*\)\s*$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function regionOf(el: Element): string {
  if (el.closest(".context-menu")) return "context";
  if (el.closest(".menu-popup, #menubar")) return "menu";
  if (el.closest(".home, .modal-overlay, .choice-backdrop, .cmdk-backdrop, [role=dialog]")) return "dialog";
  if (el.closest("#toolrail, .rail-flyout")) return "toolrail";
  if (el.closest("#titlebar")) return "titlebar";
  if (el.closest(".timeline-props")) return "props";
  if (el.closest("#timeline")) return "history";
  if (el.closest("#browser")) return "items";
  if (el.closest(".dim-input, .dim-unit-menu")) return "valuebox";
  if (el.closest("#renderdock")) return "render";
  if (el.closest("#viewcontrols, .float-popover")) return "views";
  if (el.matches(TEXT_ONLY)) return "status";
  return "other";
}

const GENERATED_ID = /^(v-|\d)|-\d{3,}$/;

export function refOf(el: HTMLElement): string {
  const d = el.dataset;
  if (el instanceof HTMLInputElement) {
    const f = el.closest<HTMLElement>(".dim-field[data-field]");
    if (f) return `field:${f.dataset.field}`;
    const p = el.closest<HTMLElement>(".param-row[data-field]");
    if (p) return `prop:${p.dataset.field}`;
  }
  if (el.id && !GENERATED_ID.test(el.id)) return `#${el.id}`;
  if (el.matches(".timeline-node") && d.id) return `feature:${d.id}`;
  if (el.matches(".feature-row, .tree-folder") && d.id) return `item:${d.id}`;
  if (el.matches(".tree-folder") && d.key) return `folder:${d.key}`;
  if (el.matches(".tree-eye")) {
    const row = el.closest<HTMLElement>(".feature-row, .tree-folder");
    const key = row?.dataset.id ?? row?.dataset.key;
    if (key) return `eye:${key}`;
  }
  if (d.action) return `action:${d.action}`;
  if (d.family) return `family:${d.family}`;
  if (d.pick) return `pick:${d.pick}`;
  if (d.group) return `group:${d.group}`;
  if (d.testid) return `testid:${d.testid}`;
  if (d.workspace) return `workspace:${d.workspace}`;
  if (d.viewMode) return `view-mode:${d.viewMode}`;
  if (d.category) return `category:${d.category}`;
  if (d.tab && el.getAttribute("role") === "tab") return `tab:${d.tab}`;
  const label = labelOf(el);
  if (el.matches(".menu-btn")) return `menu:${label}`;
  if (el.matches(".menu-item")) {
    const parent = el.closest(".menu")?.querySelector(".menu-btn");
    return `menu:${parent ? visibleText(parent) : "?"}/${label}`;
  }
  if (el.matches(".ctx-item")) return `ctx:${label}`;
  if (el.matches(".choice-btn")) return `choice:${label}`;
  if (el.matches(".opt-row")) return `opt:${label}`;
  return `text:"${label}"`;
}

function roleOf(el: HTMLElement): string {
  if (el.matches(TEXT_ONLY)) return "text";
  if (el.matches(".timeline-node")) return "chip";
  if (el.matches(".feature-row, .tree-folder")) return "row";
  if (el.matches(".tree-eye")) return "eye";
  if (el.matches(".menu-item, .ctx-item, [role=menuitem]")) return "item";
  if (el instanceof HTMLInputElement) return el.type === "checkbox" ? "checkbox" : "input";
  if (el instanceof HTMLSelectElement) return "select";
  if (el instanceof HTMLTextAreaElement) return "input";
  return el.getAttribute("role") ?? (el instanceof HTMLAnchorElement ? "link" : "button");
}

function flagsOf(el: HTMLElement, disabled: boolean): string[] {
  const f: string[] = [];
  if (el.dataset.visible) return [el.dataset.visible === "false" ? "hidden" : "visible"];
  if (disabled) f.push("disabled");
  if (el.classList.contains("selected") || el.getAttribute("aria-selected") === "true") f.push("selected");
  if (el.classList.contains("active") || el.getAttribute("aria-pressed") === "true") f.push("on");
  if (el.classList.contains("error")) f.push("error");
  if (el.classList.contains("suppressed")) f.push("suppressed");
  if (el.classList.contains("dirty")) f.push("dirty");
  const exp = el.getAttribute("aria-expanded");
  if (exp === "true") f.push("open");
  if (exp === "false" && el.matches(".tree-folder")) f.push("closed");
  if (el instanceof HTMLInputElement && el.type === "checkbox") f.push(el.checked ? "checked" : "unchecked");
  else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) f.push(`= "${clip(el.value)}"`);
  else if (el instanceof HTMLSelectElement) f.push(`= "${clip(el.selectedOptions[0]?.textContent?.trim() ?? el.value)}"`);
  return f;
}

function hiddenSelf(el: Element): boolean {
  if (el.classList.contains("hidden") || el.hasAttribute("inert") || (el as HTMLElement).hidden) return true;
  const cs = getComputedStyle(el);
  return cs.display === "none" || cs.visibility === "hidden";
}

function clips(el: Element): boolean {
  const cs = getComputedStyle(el);
  return /(auto|scroll|hidden)/.test(cs.overflowY || cs.overflow || "");
}

const overlaps = (a: Box, b: Box) =>
  a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

export interface Walk {
  controls: Control[];
  /** Controls scrolled out of their list, by region. */
  more: Record<string, number>;
  /** A word or two printed after a region's name. */
  notes: Record<string, string>;
}

/** Every visible control, in document order. */
export function walkControls(doc: Document = document, opts: WalkOptions = {}): Walk {
  const rect = opts.rect ?? realRect;
  const controls: Control[] = [];
  const more: Record<string, number> = {};
  const visit = (el: Element, clipBox: Box | null) => {
    if (hiddenSelf(el)) return;
    let box = clipBox;
    if (el instanceof HTMLElement && el.matches(CONTROL)) {
      const r = rect(el);
      if (r.width > 0 || r.height > 0) {
        const region = regionOf(el);
        if (box && !overlaps(r, box)) more[region] = (more[region] ?? 0) + 1;
        else {
          const disabled = (el as HTMLButtonElement).disabled === true
            || el.classList.contains("disabled") || el.getAttribute("aria-disabled") === "true";
          controls.push({ el, ref: refOf(el), role: roleOf(el), label: labelOf(el), flags: flagsOf(el, disabled), region, disabled });
        }
      }
      if (el.matches("button, input, select, textarea, .ctx-item, .menu-item")) return;
    } else if (el !== doc.body && el instanceof HTMLElement && clips(el)) {
      const r = rect(el);
      if (r.width > 0 && r.height > 0) box = r;
    }
    for (const c of Array.from(el.children)) visit(c, box);
  };
  if (doc.body) visit(doc.body, null);
  const notes: Record<string, string> = {};
  const mode = doc.querySelector<HTMLElement>("#toolrail")?.dataset.mode;
  if (mode) notes.toolrail = `mode=${mode}`;
  return { controls, more, notes };
}

export interface ScreenArgs {
  region?: string;
  max?: number;
}

/** The readout `s.screen()` prints: region headers at depth 0, controls at 1. */
export function screenLines(walk: Walk, args: ScreenArgs = {}): { lines: Line[]; truncated: number } {
  const max = args.max ?? 150;
  const lines: Line[] = [];
  let truncated = 0;
  for (const region of REGIONS) {
    if (args.region && args.region !== region) continue;
    const rows = walk.controls.filter((c) => c.region === region);
    const hidden = walk.more[region] ?? 0;
    if (!rows.length && !hidden) continue;
    const block: Line[] = [[0, region, "region", walk.notes[region] ?? "", []]];
    for (const c of rows) block.push([1, c.ref, c.role, c.label, c.flags]);
    if (hidden) block.push([1, "", "more", `${hidden} more`, []]);
    for (const l of block) {
      if (lines.length >= max) truncated++;
      else lines.push(l);
    }
  }
  return { lines, truncated };
}
