// The 3D-mouse capability: everything that has to happen for a plugged-in
// puck to move the view, and everything that has to be undone when the
// capability is turned off.
//
// This file is the whole of the app's knowledge that a 3D mouse exists. Nothing
// in the core imports it; plugins/activate.ts loads it when the capability is
// on, which is also what keeps the HID reader, the settings modal and the input
// filter out of the main bundle on the machines that have no such device, which
// is most of them.

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { initSpaceMouse, setSpaceMouseConfig } from "../../src/input/spacemouse";
import { stickyFact } from "../../src/diagnostics/breadcrumbs";
import { toast } from "../../src/ui/toast";
import type { Engine } from "../../src/app/engine";
import type { Viewport } from "../../src/viewport/viewport";

type Inventory = { picked: string | null; seen: string[]; note?: string | null };

/** Start the capability. Returns the teardown that stops it.
 *
 *  The teardown is not decoration. This can be switched off while the app is
 *  running, and off has to mean the frame loop stops, the event listeners go,
 *  and the reader on the Rust side lets go of the device. A capability that is
 *  "off" while still holding an HID handle open is one that can stop another
 *  program from using the hardware, which is exactly the complaint the udev
 *  note in spacemouse.rs is about, arriving from the other direction. */
export async function activate(e: Engine): Promise<() => void> {
  const stops = await install(e.viewport);
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
      if (pressed & 1) viewport.fitView(); // button 1 → Fit
      else if (pressed & 2) viewport.setStandardView("iso"); // button 2 → Home/ISO
    }),
  );

  // The device is PRESENT but the OS won't let us open it — on Linux that means the
  // hidraw udev rule is missing (packaged installs ship it; AppImage can't), or
  // spacenavd/the 3Dconnexion driver is holding it. Without this the reader failed
  // into stderr and retried forever, so a plugged-in SpaceMouse just did nothing
  // with no way to find out why. Guarded to Tauri: plain `vite` has no emitter.
  if (!("__TAURI_INTERNALS__" in window)) return stops;

  stops.push(
    await listen<{ name: string; detail: string }>("spacemouse:blocked", (ev) => {
      console.warn("SpaceMouse blocked:", ev.payload.detail);
      toast(
        `Found "${ev.payload.name}" but can't read it, see the SpaceMouse section of the README`,
        { kind: "error", timeout: 15000 },
      );
    }),
  );

  // The HID inventory, recorded SILENTLY — never a toast. Most users own no 3D
  // mouse, so "no device" must stay quiet; but that silence is exactly why a
  // tester whose hardware differs from ours filed a bug report with no trace of
  // the SpaceMouse in it. Chunked because a crumb is capped at 300 chars, and
  // sticky so twenty later toasts can't evict it.
  let recorded = ""; // the listener and the pull below can both deliver the same one
  const recordInventory = (payload: {
    picked: string | null;
    seen: string[];
    note?: string | null;
  }) => {
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

  // Listen FIRST, then start the reader, then ask.
  //
  // The reader used to be started from Tauri's setup and published within
  // milliseconds of launch, long before this file had run, and Tauri does not
  // replay an event to a listener that registers afterwards. The listener alone
  // therefore missed the inventory on every normal start, which is why the MX
  // Anywhere 3s report (0.1.85) carried no [spacemouse] crumb at all and could
  // not be told apart from an unrelated stuck-orbit bug. Starting the reader
  // from here closes that gap by construction.
  //
  // The pull stays, for a different reason than it was added for: the start
  // command is idempotent, so turning this capability off and on again inside
  // one session can find the reader still alive, and a reader that is already
  // running publishes the inventory only when it CHANGES. The pull is then the
  // only way the fresh listener learns what the old one was told.
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
      /* no reader on this platform — nothing to record */
    });

  // Let go of the device. Best effort: if the command is not there, the reader
  // was never started either.
  stops.push(() => {
    void invoke("spacemouse_stop").catch(() => {});
  });

  return stops;
}
