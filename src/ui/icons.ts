// Stroke icons, one SVG per mark under src/assets/icons/<pack>/<name>.svg; only the inner markup is kept and wrapped
// in the shared <svg>. House style: 24x24 viewBox, about 20x20 live area, stroke-width 1.4, round caps, fill="none".

import { contributedIcons } from "../plugins/contrib";
import { readSetting } from "./storedSetting";

/** `paths` maps an icon name to the inner markup drawn inside the shared 24×24 stroke wrapper. */
export interface IconPack {
  id: string;
  /** Shown in the settings menu. */
  label: string;
  paths: Readonly<Record<string, string>>;
}

const FILES = import.meta.glob<string>("../assets/icons/*/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
});

export function innerSvg(file: string): string {
  const m = /<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/.exec(file.trim());
  return (m?.[1] ?? "").trim();
}

function packPaths(pack: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [file, raw] of Object.entries(FILES)) {
    const m = /\/icons\/([^/]+)\/([^/]+)\.svg$/.exec(file);
    if (m && m[1] === pack) out[m[2]!] = innerSvg(raw);
  }
  return out;
}

/** Hairline strokes. The fallback every other pack resolves against, so it must stay complete. */
export const FORGE_PACK: IconPack = {
  id: "forge",
  label: "Forge (outline)",
  paths: packPaths("forge"),
};

/** A heavier variant: the same shapes with their counters filled in, redrawn
 *  only for the marks that appear dozens of times on screen at small sizes. */
export const ANVIL_PACK: IconPack = {
  id: "anvil",
  label: "Anvil (solid)",
  paths: packPaths("anvil"),
};

export const DEFAULT_PACK_ID = FORGE_PACK.id;

const PACKS = new Map<string, IconPack>([
  [FORGE_PACK.id, FORGE_PACK],
  [ANVIL_PACK.id, ANVIL_PACK],
]);

/** Active pack, default pack, plugins, then "": an unknown name is a call site typo, and an empty <svg> beats a crash.
 *  Plugins come after both packs so they only fill names no pack has, never punch holes in the chosen look. */
export function resolveIconPaths(
  packs: ReadonlyMap<string, IconPack>,
  activeId: string,
  name: string,
  defaultId: string = DEFAULT_PACK_ID,
  extra: Readonly<Record<string, string>> = {},
): string {
  return packs.get(activeId)?.paths[name] ?? packs.get(defaultId)?.paths[name] ?? extra[name] ?? "";
}

const KEY = "fundacad.iconPack";
const LEGACY_KEYS = ["neocad.iconPack", "sindricad.iconPack"];

/** Every boundary that sets the active pack goes through here: an unknown id makes every lookup fall back to the
 *  default, which looks like the setting silently not working. */
export function asIconPackId(v: unknown): string | null {
  return typeof v === "string" && PACKS.has(v) ? v : null;
}

function readStored(): string {
  const raw = readSetting(KEY, ...LEGACY_KEYS);
  return asIconPackId(raw) ?? DEFAULT_PACK_ID;
}

let activePackId = readStored();
const listeners = new Set<() => void>();

export function getIconPack(): string {
  return activePackId;
}

export function setIconPack(id: string) {
  const next = asIconPackId(id);
  if (!next || next === activePackId) return;
  activePackId = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* private mode / no storage: the choice just doesn't survive the session */
  }
  for (const fn of listeners) fn();
}

export function onIconPackChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function iconPacks(): IconPack[] {
  return [...PACKS.values()];
}

/** Lets a pack ship separately from this file. */
export function registerIconPack(pack: IconPack) {
  PACKS.set(pack.id, pack);
}

/** For Icon.vue's v-html, the one sanctioned use in the app: safe only because the files are bundled from the repo
 *  and tests/ui/iconFiles.test.ts refuses scripts, event handlers and hard colours. */
export function iconPaths(name: string): string {
  return resolveIconPaths(PACKS, activePackId, name, DEFAULT_PACK_ID, contributedIcons());
}

/** For a caller with a string slot. Prefer <Icon>, or iconElement() in imperative DOM code. */
export function icon(name: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${iconPaths(name)}</svg>`;
}

/** For surfaces built with document.createElement (the sketch dimension box). Its innerHTML is the same sanctioned
 *  exception as Icon.vue's v-html, kept in one function so there is one place to audit. */
export function iconElement(name: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  // `.icon { flex: 0 0 auto }` keeps the icon from collapsing in a flex slot; the heads-up box marks drew 0px wide.
  svg.setAttribute("class", "icon");
  svg.setAttribute("data-icon", name);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.4");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.innerHTML = iconPaths(name);
  return svg;
}
