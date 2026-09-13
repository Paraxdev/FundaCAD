// Stroke icons (24x24, currentColor) for the whole app, one SVG file per mark
// under src/assets/icons/<pack>/<name>.svg. The loader keeps only each file's
// INNER markup; Icon.vue and iconElement() wrap it in the <svg> carrying the
// shared viewBox / stroke / linecap so no icon can drift off the house weight.
//
// HOUSE STYLE, hold to it when adding files: a 24x24 viewBox with a roughly
// 20x20 live area, stroke-width 1.4 on the root, round caps and joins,
// fill="none". A per-path `stroke-width` is for the few marks that are meant to
// read heavier than a line of geometry: a tick, a close cross, the bar of a
// warning sign.
//
// Note: this markup reaches the DOM through v-html. It is safe only because the
// files are bundled at build time from the repo, no document data, file name or
// network payload can reach them, and tests/ui/iconFiles.test.ts refuses a file
// with a script, an event handler or a hard colour.
//
// A pack is a folder; the user picks one, and any name the chosen pack does not
// define resolves against the default pack. That fallback is what makes a pack
// cheap to write, a variant redraws only the marks whose weight it wants to
// change.

import { contributedIcons } from "../plugins/contrib";
import { readSetting } from "./storedSetting";

/** A named, self-contained icon table. `paths` maps a semantic icon name to the
 *  inner SVG markup drawn inside the shared 24×24 stroke wrapper. */
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

/** The markup inside a file's root <svg>. */
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

/** The house pack: hairline strokes, open counters, nothing filled that doesn't
 *  have to be. Also the fallback every other pack resolves against, which is why
 *  it is the one pack that must stay complete. */
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

/** The pack every lookup falls back to, see resolveIconPaths. */
export const DEFAULT_PACK_ID = FORGE_PACK.id;

const PACKS = new Map<string, IconPack>([
  [FORGE_PACK.id, FORGE_PACK],
  [ANVIL_PACK.id, ANVIL_PACK],
]);

/** Pack resolution, as a pure function of the whole registry, the part with the
 *  actual rule in it, and therefore the part under test.
 *
 *  Four tiers, in order: the active pack, the default pack, whatever a plugin
 *  contributed, then the empty string. The last one is not an oversight. An icon
 *  name that nothing knows is a typo at a call site, and rendering an empty
 *  <svg> keeps the button the same size with the same label instead of throwing
 *  during a render, a missing mark is a cosmetic bug, a crashed panel is a lost
 *  document.
 *
 *  PLUGINS COME LAST, after both packs, and the order is the whole rule: a pack
 *  is a look the user chose for the entire app, so a plugin that shipped its own
 *  idea of a mark must not punch a hole in it. It fills a name no pack has,
 *  which is what a tool the app does not have needs, and nothing else. */
export function resolveIconPaths(
  packs: ReadonlyMap<string, IconPack>,
  activeId: string,
  name: string,
  defaultId: string = DEFAULT_PACK_ID,
  extra: Readonly<Record<string, string>> = {},
): string {
  return (
    packs.get(activeId)?.paths[name] ?? packs.get(defaultId)?.paths[name] ??
    extra[name] ?? ""
  );
}

// --- the active pack, as a user setting --------------------------------------
//
// Persisted the way every other display preference in this app is (ui/units.ts,
// ui/welcome.ts, io/recentFiles.ts): a `fundacad.*` localStorage key read once
// at module load, plus a listener set so the live UI re-renders instead of
// waiting for a reload.

const KEY = "fundacad.iconPack";
const LEGACY_KEYS = ["neocad.iconPack", "sindricad.iconPack"];

/** Narrow an untrusted string, a stored setting, a `<select>` value, to a
 *  registered pack id, or null. Every boundary that can set the active pack goes
 *  through here: an unknown id would make EVERY lookup fall through to the
 *  default pack, which looks exactly like the setting silently not working. */
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

/** Subscribe to pack changes; returns the unsubscribe. */
export function onIconPackChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Every registered pack, for the settings menu. */
export function iconPacks(): IconPack[] {
  return [...PACKS.values()];
}

/** Add a pack at runtime (or replace one by id). Exists so a pack can ship
 *  separately from this file without every consumer learning about it. */
export function registerIconPack(pack: IconPack) {
  PACKS.set(pack.id, pack);
}

/** The raw path markup for one icon in the ACTIVE pack, for Icon.vue's v-html,
 *  the ONE sanctioned one in the app (see the note at the top of this file). */
export function iconPaths(name: string): string {
  return resolveIconPaths(PACKS, activePackId, name, DEFAULT_PACK_ID, contributedIcons());
}

/** One complete `<svg>` as markup, for the rare caller that has a string slot
 *  rather than a component slot. Prefer <Icon>; prefer iconElement() in
 *  imperative DOM code. */
export function icon(name: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${iconPaths(name)}</svg>`;
}

/** An `<svg>` ELEMENT, for the handful of surfaces still built with
 *  document.createElement (the sketch dimension box).
 *
 *  The innerHTML here is the same sanctioned exception Icon.vue's v-html is, and
 *  for the same reason: the only thing that reaches it is the bundled icon
 *  files. It is a function rather than an inlined snippet at each call site so
 *  there is exactly one place to audit. */
export function iconElement(name: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  // The same class and marker Icon.vue puts on its <svg>, and not decoration:
  // `.icon { flex: 0 0 auto }` is what stops an icon collapsing when its slot is
  // a flex container. Without it the confirm/cancel marks on the heads-up box
  // laid out 0px wide inside their `display: inline-flex` buttons and drew as
  // two empty squares, the paths were there and correct the whole time.
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
