// The pure half of this capability: what a palette slot means, and how a colour
// finds one.
//
// No DOM, no Vue, no Tauri. Both functions used to live in src/ — the body
// colour menu in ui/browserTree.ts beside the assembly-tree shaping, and the
// nearest-slot match in io/files.ts beside the import path that called it — and
// both are only about a palette, which is this capability's whole subject.

import type { DocumentStore } from "../../src/document/store";
import type { CtxItem } from "../../src/ui/menu";

/** The "Color" entry for a body's right-click menu.
 *
 *  A list to be spread rather than an item to be placed, so that "no entry at
 *  all" is expressible: an entry whose submenu happened to be empty would open
 *  onto nothing. This capability only contributes it while it is running, so
 *  the empty case now falls out of not being asked. */
export function bodyColorMenu(store: DocumentStore, bodyId: string): CtxItem[] {
  return [{ label: "Color", children: bodyColorMenuItems(store, bodyId) }];
}

/** Palette → menu items for assigning a body's color slot. Exported for the
 *  test that pins the swatches and the disabled current slot. */
export function bodyColorMenuItems(store: DocumentStore, bodyId: string): CtxItem[] {
  const slot = store.bodyColorSlot(bodyId);
  return [
    ...store.colorPalette.map((s, i) => ({
      label: s.name,
      swatch: s.color,
      disabled: slot === i,
      onClick: () => store.setBodyColorSlot(bodyId, i),
    })),
    { label: "None", disabled: slot == null, onClick: () => store.setBodyColorSlot(bodyId, null) },
  ];
}

/** Nearest palette slot to a '#RRGGBB' colour, by squared RGB distance, or null
 *  when the palette is empty or the colour is unparseable.
 *
 *  Deliberately MATCHES rather than extends. The palette is a filament list —
 *  four physical slots — not a display palette, so a slot means "print this in
 *  filament N". Auto-adding an imported model's colour would claim a filament
 *  the printer doesn't have loaded. */
export function nearestPaletteSlot(
  hex: string,
  palette: { name: string; color: string }[],
): number | null {
  const rgb = (s: string): [number, number, number] | null => {
    const t = s.trim().replace(/^#/, "");
    if (!/^[0-9a-f]{6}$/i.test(t)) return null;
    return [parseInt(t.slice(0, 2), 16), parseInt(t.slice(2, 4), 16), parseInt(t.slice(4, 6), 16)];
  };
  const want = rgb(hex);
  if (!want || !palette.length) return null;
  let best: number | null = null;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const got = rgb(palette[i]?.color ?? "");
    if (!got) continue;
    const d = (want[0] - got[0]) ** 2 + (want[1] - got[1]) ** 2 + (want[2] - got[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Every colour this document puts on the model: bodies by their slot
 *  assignment, and the per-face inlays a two-tone texture produced.
 *
 *  Both maps used to be built inside app/rebuildBridge.ts, which is the one
 *  place in the app whose job is turning a build result into pixels and which
 *  therefore had to know what a palette was, what a slot meant, and which
 *  capability decided whether either counted. It reads a contribution now, and
 *  this is what is behind it. */
export function paintFrom(store: DocumentStore): {
  bodies: Record<string, string>;
  faces: Record<number, string>;
} {
  const pal = store.colorPalette;
  const bodies: Record<string, string> = {};
  const faces: Record<number, string> = {};
  for (const b of store.buildState.result?.bodies ?? []) {
    const slot = store.bodyColorSlot(b.id);
    if (slot != null && pal[slot]) bodies[b.id] = pal[slot].color;
    // two-tone texture inlays: the sidecar's dense per-body face array becomes a
    // sparse global-face-index key.
    const slots = b.textureColorSlots;
    if (!slots) continue;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s != null && pal[s]) faces[b.faceStart + i] = pal[s].color;
    }
  }
  return { bodies, faces };
}

/** What a machine says is loaded in each of its toolheads.
 *
 *  The contract between this capability and whichever one can talk to a printer,
 *  looked up by name through the core's `service()` and satisfied by nobody in a
 *  build that has no printer support. The core never looks inside it: it stores
 *  the value and hands it back, exactly as it compares grant strings without
 *  knowing what a grant means.
 *
 *  Named on THIS side because this is the side that cannot work without it. A
 *  palette with no machine behind it is four fixed rows of nothing. */
export interface FilamentSource {
  /** Whether a machine answered. Never throws; false is "did not answer". */
  probe(): Promise<boolean>;
  /** What each toolhead has loaded, by index. Throws when unreachable. */
  read(): Promise<FilamentSlot[]>;
  /** Pull them into the palette, asking first if it has been customised.
   *  Returns whether anything was written. */
  sync(store: DocumentStore): Promise<boolean>;
}

export interface FilamentSlot {
  index: number;
  present: boolean;
  vendor: string;
  material: string;
  color: string;
}

export const FILAMENTS = "filaments";

/** Slots where the machine's loaded filament differs from the palette — the
 *  same name/color criteria the sync confirmation diffs on. */
export function staleSlots(
  palette: { name: string; color: string }[],
  filaments: FilamentSlot[],
): number[] {
  const out: number[] = [];
  filaments.forEach((f, i) => {
    if (!f.present || i >= palette.length) return;
    const name = `${f.vendor} ${f.material}`.trim() || `Toolhead ${f.index + 1}`;
    if (palette[i]?.name !== name || palette[i]?.color !== f.color) out.push(i);
  });
  return out;
}
