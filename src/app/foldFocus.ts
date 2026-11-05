// Focus across the narrow stage switch (STAGE_NARROW_PX): a card that folds into its drawer, or a drawer switch that
// goes away when the cards unfold, takes focus with it to the page.

import { focusables, mainLandmark } from "../components/ui/focusables";

type Drawer = "items" | "history";

// The sketch options take History's place while a sketch is open.
const CARDS: Record<Drawer, string> = { items: "#browser", history: "#timeline, #palette" };

function drawerOf(el: Element | null): Drawer | null {
  if (!el || el === document.body) return null;
  const sw = el.closest<HTMLElement>("[data-drawer-switch]")?.dataset.drawerSwitch;
  if (sw === "items" || sw === "history") return sw;
  return (["items", "history"] as const).find((d) => el.closest(CARDS[d])) ?? null;
}

/** Call before the stage turns narrow or wide and run what it returns once the DOM has followed. When focus fell to
 *  the page it goes to the drawer's switch, else to the card's first control after its close button, else to main. */
export function foldFocus(active: Element | null = document.activeElement): () => void {
  const drawer = drawerOf(active);
  if (!drawer) return () => {};
  return () => {
    const now = document.activeElement;
    if (now && now !== document.body && now.isConnected) return;
    const sw = document.querySelector<HTMLElement>(`[data-drawer-switch="${drawer}"]`);
    const first = focusables(document.querySelector(CARDS[drawer])).find((el) => !el.closest(".float-card-close"));
    for (const el of [sw, first]) {
      el?.focus();
      if (el && document.activeElement === el) return;
    }
    mainLandmark()?.focus();
  };
}
