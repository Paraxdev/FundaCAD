import { nextTick } from "vue";
import { isMac } from "../../input/platform";

/** The click a key press on a row stands for: Space is the platform's toggle click (Ctrl, Cmd on macOS), Shift+Space a
 *  Shift click for a run, and Enter a plain click. */
export function keyClick(e: KeyboardEvent): MouseEvent {
  const toggle = e.key === " ";
  return new MouseEvent("click", {
    ctrlKey: toggle && !isMac(),
    metaKey: toggle && isMac(),
    shiftKey: e.shiftKey,
  });
}

/** A rename begun from the keys hands focus back to its row when Enter or Escape closes the field, where the page
 *  would otherwise leave it on the body. One that a pointer began leaves focus alone, as it always did. */
export function useKeyRename(start: () => void, row: () => HTMLElement | null | undefined) {
  let byKeys = false;
  return {
    start(fromKeys = false) {
      byKeys = fromKeys;
      start();
    },
    onKeydownCapture(e: KeyboardEvent) {
      if (!byKeys || (e.key !== "Enter" && e.key !== "Escape")) return;
      if (!(e.target as HTMLElement | null)?.closest?.(".tree-label.renaming")) return;
      byKeys = false;
      const el = row();
      // The field closes after this capture handler, so the first tick still finds it open: wait for its redraw.
      void nextTick(() =>
        nextTick(() => {
          const now = document.activeElement;
          if (el?.isConnected && (!now || now === document.body)) el.focus();
        }),
      );
    },
  };
}
