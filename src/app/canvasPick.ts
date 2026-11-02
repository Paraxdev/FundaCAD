/** Makes the canvas a Tab stop that a pointer press does not land on: with no focus change on a press, every path that
 *  hands focus back only from the body keeps working (focusables.ts, treeRowKeys.ts, Menu.vue, Select.vue). */
export function installCanvasStop(canvas: HTMLElement): void {
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "3D view");
  canvas.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    const active = document.activeElement;
    if (active !== canvas && active instanceof HTMLElement) active.blur();
  });
}
