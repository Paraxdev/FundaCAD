// The app knows nothing about 3D mice beyond the `contribute` call below. Everything else is reached only from here, so
// a machine with no such device, which is most of them, never downloads or parses it.

import {
  PLUGIN_ID,
  blockedText,
  getSpaceMouseMode,
  initSpaceMouse,
  setSpaceMouseConfig,
  setSpaceMouseMode,
  settings,
  type DeviceBlocked,
} from "./spacemouse";
import { defineAsyncComponent } from "vue";
import { contribute, invoke, listen, openPluginSettings, stickyFact, toast } from "fundacad";
import type { Engine, Viewport } from "fundacad";

type Inventory = { picked: string | null; seen: string[]; note?: string | null };

/** Returns the teardown. Off must stop the frame loop and the listeners and release the HID handle on the Rust side,
 *  or another program cannot use the device. */
export async function activate(e: Engine): Promise<() => void> {
  const stops = await install(e.viewport);

  // These items join the core View menu, and with the capability off they are absent. `checked` is re-evaluated each time a
  // menu opens, so the mode is read straight from the module.
  stops.push(
    contribute("FundaCAD.SpaceMouse", {
      menus: [
        {
          menu: "View",
          before: "Help",
          items: [
            { separator: true, label: "" },
            {
              label: "SpaceMouse: Object Mode",
              checked: () => getSpaceMouseMode() === "object",
              onClick: () => setSpaceMouseMode("object"),
            },
            {
              label: "SpaceMouse: Camera Mode",
              checked: () => getSpaceMouseMode() === "camera",
              onClick: () => setSpaceMouseMode("camera"),
            },
            { separator: true, label: "" },
            { label: "3D Mouse Settings\u2026", onClick: () => openPluginSettings(PLUGIN_ID) },
          ],
        },
      ],
      // Async, so three.js and the test cube stay out of the chunk that starts
      // the plugin; the row only builds them when it is expanded.
      settings: [
        { key: "spacemouse", settings, component: defineAsyncComponent(() => import("./SpaceMouseSection.vue")) },
      ],
    }),
  );

  return () => {
    for (const stop of stops.reverse()) stop();
  };
}

async function install(viewport: Viewport): Promise<(() => void)[]> {
  const stops: (() => void)[] = [];
  (window as any).spaceMouseConfig = setSpaceMouseConfig; // live-tune from devtools
  stops.push(() => {
    delete (window as any).spaceMouseConfig;
  });

  stops.push(
    await initSpaceMouse(viewport, (pressed) => {
      if (pressed & 1) viewport.fitView();
      else if (pressed & 2) viewport.setStandardView("iso");
    }),
  );

  // The device is present but the OS will not let us open it: on Linux the hidraw udev rule is missing (an AppImage
  // cannot ship it) and no spacenavd socket exists. Guarded to Tauri, plain `vite` has no emitter.
  if (!("__TAURI_INTERNALS__" in window)) return stops;

  stops.push(
    await listen<DeviceBlocked>("spacemouse:blocked", (ev) => {
      console.warn("SpaceMouse blocked:", ev.payload.detail);
      toast(blockedText(ev.payload), { kind: "error", timeout: 15000 });
    }),
  );

  // The HID inventory goes to sticky crumbs, never a toast, since most users own no 3D mouse but a bug report needs the
  // trace. Chunked because a crumb is capped at 300 chars.
  let recorded = ""; // the listener and the pull below can both deliver the same one
  const recordInventory = (payload: { picked: string | null; seen: string[]; note?: string | null }) => {
    const { picked, seen, note } = payload;
    const fingerprint = `${picked}|${note}|${seen.join(",")}`;
    if (fingerprint === recorded) return;
    recorded = fingerprint;
    stickyFact(`[spacemouse] picked ${picked ?? "nothing"}, of ${seen.length} HID interfaces:`);
    if (note) stickyFact(`[spacemouse] ${note}`);
    const PER_LINE = 3;
    const MAX_LINES = 8;
    const shown = Math.min(seen.length, PER_LINE * MAX_LINES);
    for (let i = 0; i < shown; i += PER_LINE) {
      stickyFact(`[spacemouse]   ${seen.slice(i, i + PER_LINE).join(" | ")}`);
    }
    if (seen.length > shown) stickyFact(`[spacemouse]   +${seen.length - shown} more`);
  };

  // Listen first, then start the reader, then ask: Tauri does not replay an event to a listener that registers late.
  // The pull covers a reader still alive from an earlier off and on, which publishes the inventory only when it changes.
  void listen<Inventory>("spacemouse:devices", (ev) => recordInventory(ev.payload))
    .then((off) => {
      stops.push(off);
      return invoke("spacemouse_start");
    })
    .then(() => invoke<Inventory | null>("spacemouse_inventory"))
    .then((inv) => {
      if (inv) recordInventory(inv);
    })
    .catch(() => {
      /* no reader on this platform, nothing to record */
    });

  // Best effort: when the command is missing, the reader was never started either.
  stops.push(() => {
    void invoke("spacemouse_stop").catch(() => {});
  });

  return stops;
}
