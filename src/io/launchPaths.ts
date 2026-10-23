import type { Engine } from "../app/engine";
import { openPathGuarded } from "../app/documentActions";
import { closeHome } from "../ui/home";
import { toast } from "../ui/toast";

type LaunchEngine = Pick<Engine, "store" | "sketch" | "geometry">;

/** Open the document the app was started with, then each one a later launch
 *  hands over (a double click in a file manager while FundaCAD runs). Waits for
 *  `after`, the recovery prompt, so two questions never stand at once. */
export function installLaunchPaths(e: LaunchEngine, after: Promise<unknown> = Promise.resolve()): void {
  if (!("__TAURI_INTERNALS__" in globalThis)) return;
  let queue: Promise<void> = after.then(
    () => {},
    () => {},
  );
  const drain = () => {
    queue = queue.then(() => drainLaunchPaths(e)).catch((err) => console.warn("launch paths failed:", err));
  };
  void import("@tauri-apps/api/event").then(({ listen }) => listen("launch-paths", drain)).then(drain);
}

export async function drainLaunchPaths(e: LaunchEngine): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  const paths = await invoke<string[]>("take_launch_paths");
  const first = paths[0];
  if (!first) return;
  if ((await openPathGuarded(e, first)) !== "ok") return;
  closeHome();
  if (paths.length > 1) {
    toast(`Opened ${first.split(/[\\/]/).pop()}, FundaCAD opens one document at a time`, {
      kind: "info",
      timeout: 8000,
    });
  }
}
