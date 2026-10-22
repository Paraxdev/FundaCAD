import { listen } from "@tauri-apps/api/event";
import { toast } from "../ui/toast";

interface Death {
  kind: string;
  cause: string;
  detail?: string;
}

/** Shows the cause, since field reports arrive as screenshots of this toast. */
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

/** Listens to the engine supervisor in src-tauri/src/engine.rs, which only exists under Tauri. */
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
