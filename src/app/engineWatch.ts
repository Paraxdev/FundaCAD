import { listen } from "@tauri-apps/api/event";
import { toast } from "../ui/toast";

interface Death {
  kind: string;
  cause: string;
}

/** What to tell the user when the geometry engine goes away. `kind` separates
 *  a real crash from "the port was already taken", which is not a crash at all
 *  and needs a different thing asked of the user (bug 2c0cd78a, where a taken
 *  port was reported as "The geometry engine crashed (exit code 1)").
 *
 *  The cause is shown rather than swallowed: field reports of this arrive as
 *  screenshots of the toast, so the message itself has to carry enough to
 *  triage from. */
export function deathMessage(p: Partial<Death> | null | undefined): string {
  const cause = p && typeof p.cause === "string" && p.cause ? p.cause : "";
  const why = cause ? ` (${cause})` : "";
  switch (p?.kind) {
    case "port_in_use":
      return `FundaCAD could not start its geometry engine: ${cause}. Another copy of FundaCAD may still be running. Close it and open FundaCAD again.`;
    case "start_failed":
      return `FundaCAD could not start its geometry engine${why}. It keeps trying, and restarting FundaCAD may help.`;
    case "restarted":
      return `The geometry engine crashed${why} and was restarted. The last operation did not finish.`;
    default:
      return `The geometry engine crashed${why}. Save your work, then restart FundaCAD.`;
  }
}

/** Both shells report a dead engine: the Python sidecar's supervisor
 *  (src-tauri/src/sidecar.rs, `sidecar:died`, no respawn) and the Rust
 *  engine's (src-tauri/src/engine.rs, `engine:died`, restarts its worker).
 *  Guarded to Tauri only, plain `vite` dev has nothing to emit either. */
export function installEngineDiedToast(): void {
  if (!("__TAURI_INTERNALS__" in window)) return;
  for (const event of ["engine:died", "sidecar:died"]) {
    void listen<Death>(event, (e) => {
      toast(deathMessage(e.payload), { kind: "error", timeout: 60000 });
    });
  }
}
