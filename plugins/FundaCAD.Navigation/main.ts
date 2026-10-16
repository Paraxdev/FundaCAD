// Mouse button presets, an opt-in radial menu and a shortcut rebinding panel.
// Everything here goes through the core's binding table, keymap overrides and
// menu at the cursor; removing the plugin puts the default mouse and keys back.

import { SHORTCUTS, allCommands, contribute, keyHint, openMenuAt, radialMenuOpen } from "fundacad";
import type { Engine, PointerGesture, RadialTrigger } from "fundacad";
import NavigationSection from "./NavigationSection.vue";
import { PLUGIN_ID, RADIAL_ACTION, contextOf, keymapFor, radialItems, tableFor } from "./navigation";
import { navState, onConfigChange } from "./state";

export async function activate(e: Engine): Promise<() => void> {
  const stops: (() => void)[] = [];
  let pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  let held: string | null = null;

  const radialKey = () => keymapFor(navState.cfg).find((k) => k.action === RADIAL_ACTION)?.key.toLowerCase() ?? null;
  const onPointer = (ev: PointerEvent) => {
    pointer = { x: ev.clientX, y: ev.clientY };
  };
  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key.toLowerCase() !== radialKey()) return;
    // A held key repeats; the ring it opened is already up.
    if (ev.repeat && radialMenuOpen()) ev.stopImmediatePropagation();
    else held = ev.key.toLowerCase();
  };
  const onKeyUp = (ev: KeyboardEvent) => {
    if (ev.key.toLowerCase() === held) held = null;
  };
  window.addEventListener("pointermove", onPointer, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  stops.push(() => {
    window.removeEventListener("pointermove", onPointer, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
  });

  const label = (id: string) =>
    allCommands().find((c) => c.id === id)?.label ?? SHORTCUTS.find((s) => s.action === id)?.label ?? id;
  const openRadial = (x: number, y: number, gesture: RadialTrigger | null) => {
    const selected = e.viewport.getSelectedBodies().length + e.viewport.getSelectedFaceIds().length;
    const ids = navState.cfg.items[contextOf(e.sketch.active, selected)];
    const items = radialItems(ids, (id) => e.handleAction(id), label, keyHint);
    openMenuAt(x, y, items, gesture ? { style: "radial", gesture } : { style: "radial" });
  };
  const onGesture = (g: PointerGesture) => openRadial(g.x, g.y, { pointerId: g.pointerId });

  let remapOff: (() => void) | null = null;
  const apply = () => {
    remapOff?.();
    remapOff = null;
    const { table, problem } = tableFor(navState.cfg);
    try {
      remapOff = contribute(PLUGIN_ID, { pointerBindings: table, onPointerGesture: onGesture, keymap: keymapFor(navState.cfg) });
      navState.problem = problem;
    } catch (err) {
      navState.problem = err instanceof Error ? err.message : String(err);
    }
  };
  onConfigChange(apply);
  apply();
  stops.push(() => {
    onConfigChange(() => {});
    remapOff?.();
  });

  stops.push(
    contribute(PLUGIN_ID, {
      settings: [{ key: "navigation", title: "Mouse and keys", component: NavigationSection }],
      actions: {
        [RADIAL_ACTION]: () => {
          if (radialMenuOpen()) return;
          openRadial(pointer.x, pointer.y, held ? { key: held } : null);
        },
      },
    }),
  );

  return () => {
    for (const stop of stops.reverse()) stop();
  };
}
