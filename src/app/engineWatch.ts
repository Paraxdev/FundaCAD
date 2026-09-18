import { listen } from "@tauri-apps/api/event";
import { toast } from "../ui/toast";

interface Death {
  kind: string;
  cause: string;
  /** The supervisor's crash report, the console entry's detail. */
  detail?: string;
}

/** What to tell the user when the geometry engine goes away. `kind` separates
 *  a crash the supervisor recovered from and a worker that never started.
 *
 *  The cause is shown rather than swallowed: field reports of this arrive as
 *  screenshots of the toast, so the message itself has to carry enough to
 *  triage from. */
export function deathMessage(p: Partial<Death> | null | undefined): string {
  const cause = p && typeof p.cause === "string" && p.cause ? p.cause : "";
  const why = cause ? ` (${cause})` : "";
  switch (p?.kind) {
    case "start_failed":
      return `FundaCAD could not start its geometry engine${why}. It keeps trying, and restarting FundaCAD may help.`;
    case "restarted":
      return `The geometry engine crashed${why} and was restarted. The last operation did not finish.`;
    default:
      return `The geometry engine crashed${why}. Save your work, then restart FundaCAD.`;
  }
}

/** The app's engine supervisor (src-tauri/src/engine.rs) reports a worker
 *  that died and was restarted, or could not start. Guarded to Tauri only,
 *  plain `vite` dev has nothing to emit. */
export function installEngineDiedToast(): void {
  if (!("__TAURI_INTERNALS__" in window)) return;
  void listen<Death>("engine:died", (e) => {
    toast(deathMessage(e.payload), {
      kind: "error",
      timeout: 60000,
      source: "engine",
      detail: e.payload.detail,
    });
  });
}
