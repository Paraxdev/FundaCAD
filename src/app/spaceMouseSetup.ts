import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { initSpaceMouse, setSpaceMouseConfig } from "../input/spacemouse";
import { stickyFact } from "../diagnostics/breadcrumbs";
import { toast } from "../ui/toast";
import type { Viewport } from "../viewport/viewport";

type Inventory = { picked: string | null; seen: string[]; note?: string | null };

/** 3D mouse (SpaceMouse): navigate the camera + map buttons (desktop app). */
export function installSpaceMouse(viewport: Viewport): void {
  (window as any).spaceMouseConfig = setSpaceMouseConfig; // live-tune from devtools

  void initSpaceMouse(viewport, (pressed) => {
    if (pressed & 1) viewport.fitView(); // button 1 → Fit
    else if (pressed & 2) viewport.setStandardView("iso"); // button 2 → Home/ISO
  });

  // The device is PRESENT but the OS won't let us open it — on Linux that means the
  // hidraw udev rule is missing (packaged installs ship it; AppImage can't), or
  // spacenavd/the 3Dconnexion driver is holding it. Without this the reader failed
  // into stderr and retried forever, so a plugged-in SpaceMouse just did nothing
  // with no way to find out why. Guarded to Tauri: plain `vite` has no emitter.
  if (!("__TAURI_INTERNALS__" in window)) return;

  void listen<{ name: string; detail: string }>("spacemouse:blocked", (e) => {
    console.warn("SpaceMouse blocked:", e.payload.detail);
    toast(
      `Found "${e.payload.name}" but can't read it, see the SpaceMouse section of the README`,
      { kind: "error", timeout: 15000 },
    );
  });

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

  // Listen FIRST, then ask — and only once the listener is actually live.
  //
  // The reader thread runs from Tauri's setup and publishes within milliseconds
  // of launch, long before this file has run, and Tauri does not replay an event
  // to a listener that registers afterwards. The listener alone therefore missed
  // the inventory on every normal start, which is why the MX Anywhere 3s report
  // (0.1.85) carried no [spacemouse] crumb at all and could not be told apart
  // from an unrelated stuck-orbit bug. The pull covers anything published before
  // we were listening; the listener covers everything after. Chaining them means
  // nothing can slip through the gap between the two.
  void listen<Inventory>("spacemouse:devices", (e) => recordInventory(e.payload))
    .then(() => invoke<Inventory | null>("spacemouse_inventory"))
    .then((inv) => {
      if (inv) recordInventory(inv);
    })
    .catch(() => {
      /* no reader on this platform — nothing to record */
    });
}
