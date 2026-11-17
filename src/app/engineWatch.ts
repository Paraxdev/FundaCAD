import { listen } from "@tauri-apps/api/event";
import { toast } from "../ui/toast";
import { openReportDialog } from "../ui/bugReporter";
import { t } from "../i18n";

interface Death {
  kind: string;
  cause: string;
  detail?: string;
}

/** Shows the cause, since field reports arrive as screenshots of this toast. */
export function deathMessage(p: Partial<Death> | null | undefined): string {
  const cause = p && typeof p.cause === "string" && p.cause ? p.cause : "";
  const args = { known: cause ? "yes" : "no", cause };
  switch (p?.kind) {
    case "start_failed":
      return t("engine.died.startFailed", args);
    case "restarted":
      return t("engine.died.restarted", args);
    default:
      return t("engine.died.crashed", args);
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
      action: { label: t("engine.died.report"), onClick: openReportDialog },
    });
  });
}
