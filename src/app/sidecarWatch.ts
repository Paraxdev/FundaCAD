import { listen } from "@tauri-apps/api/event";
import { toast } from "../ui/toast";

/** Rust's sidecar supervisor (src-tauri/src/sidecar.rs) emits this if the Python
 *  geometry process crashes after launch. There's no auto-respawn (the per-launch
 *  auth token would need to rotate live), so tell the user before they keep
 *  working on top of a dead backend. Guarded to Tauri only — plain `vite` dev
 *  (no Tauri host) has nothing to emit this and listen() would just reject.
 *
 *  The payload names HOW it died ("killed by SIGKILL (9) — out of memory?"), and
 *  it is shown rather than swallowed: field reports of this arrive as screenshots
 *  of the toast, so the message itself has to carry enough to triage from. The
 *  same line is in sidecar.log, which a bug report attaches.
 *  `kind` separates a real crash from "the port was already taken", which is not a
 *  crash at all and needs a different thing asked of the user (bug 2c0cd78a, where
 *  a taken port was reported as "The geometry engine crashed (exit code 1)"). */
export function installSidecarDiedToast(): void {
  if (!("__TAURI_INTERNALS__" in window)) return;
  void listen<{ kind: string; cause: string }>("sidecar:died", (e) => {
    const p = e.payload;
    const cause = p && typeof p.cause === "string" && p.cause ? p.cause : "";
    const msg =
      p && p.kind === "port_in_use"
        ? `FundaCAD could not start its geometry engine: ${cause}. Another copy of FundaCAD may still be running. Close it and open FundaCAD again.`
        : `The geometry engine crashed${cause ? ` (${cause})` : ""}. Save your work, then restart FundaCAD.`;
    toast(msg, {
      kind: "error",
      timeout: 60000,
    });
  });
}
