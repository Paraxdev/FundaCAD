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
      // Microtasks run between the listeners of a real key press, so any nextTick here still finds the field open, which
      // a synthetic event does not show. A task runs after the whole dispatch and the field's redraw.
      setTimeout(() => {
        const now = document.activeElement;
        if (el?.isConnected && (!now || now === document.body)) el.focus();
      });
    },
  };
}

export const EYE_HELP = "Show/hide · drag across eyes to show or hide many · Alt+click to show only this";

/** The eye says what a press does to which row, so a list of them reads as rows, not as one repeated tip. */
export function eyeName(visible: boolean | undefined, label: string): string {
  return `${visible === false ? "Show" : "Hide"} ${label}`;
}

export function stateWords(words: readonly (string | false | null | undefined)[]): string {
  return words.filter(Boolean).join(", ");
}
