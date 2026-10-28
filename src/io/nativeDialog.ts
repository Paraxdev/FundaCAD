import type { OpenDialogOptions } from "@tauri-apps/plugin-dialog";
import { withFocusReturn } from "../components/ui/focusables";

type Dialog = typeof import("@tauri-apps/plugin-dialog");

/** The Tauri dialog plugin with every call wrapped in `withFocusReturn`, since WebKitGTK and WKWebView can leave
 *  focus on the body when a native dialog closes. Use it in place of `import("@tauri-apps/plugin-dialog")`. */
export async function nativeDialog(): Promise<Pick<Dialog, "open" | "save" | "message">> {
  const d = await import("@tauri-apps/plugin-dialog");
  // Looked up per call, so a test mock that defines only `save` still loads.
  const open = <T extends OpenDialogOptions>(options?: T) => withFocusReturn(() => d.open(options));
  return {
    open,
    save: (...a) => withFocusReturn(() => d.save(...a)),
    message: (...a) => withFocusReturn(() => d.message(...a)),
  };
}
