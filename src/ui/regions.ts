import { focusables, landOn, shown } from "../components/ui/focusables";
import { resolveShortcut } from "../input/shortcuts";
import { isEditableTarget } from "./focus";
import { announce } from "./announce";

/** The parts of the shell F6 and Shift+F6 step through, in that order. */
export const REGION_ORDER = [
  "menubar",
  "home",
  "tools",
  "items",
  "viewport",
  "panel",
  "palette",
  "render",
  "history",
] as const;
export type RegionKind = (typeof REGION_ORDER)[number];

export interface Region {
  kind: RegionKind;
  el: HTMLElement;
}

// The ids are the ones the e2e suite and styles already select on; data-region lets a new part opt in.
const ROOTS: Record<RegionKind, string> = {
  menubar: "#titlebar",
  home: ".home",
  tools: "#toolrail",
  items: "#browser",
  viewport: "#main",
  panel: ".ui-panel, .ui-card",
  palette: "#palette",
  render: "#renderdock",
  history: "#timeline",
};
const selector = (kind: RegionKind) => `${ROOTS[kind]}, [data-region="${kind}"]`;
const ANY = REGION_ORDER.map(selector).join(", ");

const usable = (el: HTMLElement) => el.isConnected && !el.closest("[hidden], [inert]") && shown(el);

/** Every region on screen, in F6 order, several of one kind (floating panels) in document order. */
export function regionsInOrder(root: ParentNode = document): Region[] {
  return REGION_ORDER.flatMap((kind) =>
    [...root.querySelectorAll<HTMLElement>(selector(kind))].filter(usable).map((el) => ({ kind, el })),
  );
}

/** The innermost region holding `node`, so a tool in the rail counts as tools rather than the Model around it. */
export function regionOf(node: Node | null, regions: Region[] = regionsInOrder()): Region | null {
  if (!node) return null;
  const hits = regions.filter((r) => r.el.contains(node));
  return hits.find((r) => !hits.some((o) => o !== r && r.el.contains(o.el))) ?? null;
}

export const currentRegion = (regions?: Region[]) => regionOf(document.activeElement, regions);

const memory = new WeakMap<HTMLElement, HTMLElement>();

function take(el: HTMLElement | null | undefined): boolean {
  if (!el || !usable(el)) return false;
  el.focus();
  return document.activeElement === el;
}

// The canvas only counts once it is a Tab stop of its own, until then the Model landmark takes focus.
function enterViewport(el: HTMLElement): boolean {
  const canvas = el.querySelector<HTMLElement>("canvas[tabindex]");
  return (!!canvas && canvas.tabIndex >= 0 && take(canvas)) || take(landOn(el));
}

/** Moves focus into `region`: the control last focused there, else its first Tab stop, else the region itself. */
export function focusRegion(region: Region): boolean {
  const { kind, el } = region;
  if (!usable(el)) return false;
  if (kind === "viewport") return enterViewport(el);
  const remembered = memory.get(el);
  if (remembered && el.contains(remembered) && take(remembered)) return true;
  const start = kind === "menubar" ? el.querySelector<HTMLElement>("#menubar") : null;
  const stops = [...focusables(start), ...focusables(el)];
  return stops.some((s) => take(s)) || take(landOn(el));
}

/** Steps focus to the next region (`dir` 1) or the previous one (-1), wrapping, past any that refuses focus. With
 *  focus in no region it starts at the first or the last. Returns the region entered. */
export function cycleRegion(dir: 1 | -1): Region | null {
  const regions = regionsInOrder();
  const n = regions.length;
  if (!n) return null;
  const now = currentRegion(regions);
  const at = now ? regions.indexOf(now) : dir > 0 ? -1 : n;
  for (let k = 1; k <= n; k++) {
    const next = regions[(((at + dir * k) % n) + n) % n]!;
    if (focusRegion(next)) return next;
  }
  return null;
}

const ABSENT: Partial<Record<RegionKind, string>> = {
  menubar: "The menu bar is not on screen",
  tools: "The tools are not on screen",
  items: "Items is not on screen",
  viewport: "The model is not on screen",
  panel: "No panel is open",
  history: "History is not on screen",
};

/** Focuses a region of `kind`, the one after the region holding focus when there are several (floating panels), and
 *  says so when none is on screen. */
export function goToRegion(kind: RegionKind): Region | null {
  const regions = regionsInOrder();
  const all = regions.filter((r) => r.kind === kind);
  const now = currentRegion(regions);
  const from = now ? all.indexOf(now) : -1;
  for (let k = 1; k <= all.length; k++) {
    const next = all[(from + k) % all.length]!;
    if (focusRegion(next)) return next;
  }
  announce(ABSENT[kind] ?? "That part is not on screen");
  return null;
}

let stopMemory: (() => void) | null = null;

/** Remembers the last control focused in each region, so F6 back into it lands where the user left. Idempotent,
 *  the returned stop clears it for tests. */
export function trackRegionFocus(): () => void {
  if (stopMemory) return stopMemory;
  const onIn = (e: FocusEvent) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    for (let r = target.closest<HTMLElement>(ANY); r; r = r.parentElement?.closest<HTMLElement>(ANY) ?? null)
      memory.set(r, target);
  };
  document.addEventListener("focusin", onIn, true);
  stopMemory = () => {
    document.removeEventListener("focusin", onIn, true);
    stopMemory = null;
  };
  return stopMemory;
}

/** F6 and Shift+F6 (or whatever they are remapped to) step between regions, from text fields too. On document, so it
 *  runs before keymap.ts on window and stops the key there. An F6 a key capture already claimed is left alone. */
export function installRegionKeys(context: () => "model" | "sketch"): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl && e.key.length === 1 && isEditableTarget(e.target)) return;
    const action = resolveShortcut(e.key, e.shiftKey, context(), ctrl);
    if (action !== "region-next" && action !== "region-prev") return;
    e.preventDefault();
    e.stopPropagation();
    cycleRegion(action === "region-next" ? 1 : -1);
  };
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
}
