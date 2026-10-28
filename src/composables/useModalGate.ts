import { onMounted, onUnmounted } from "vue";
import { popModal, pushModal } from "../ui/choice";

/** Holds the modal-depth gate for this component's lifetime, so global shortcuts stay off under a v-if dialog and no
 *  dismiss path can leak a pushModal(). Not in the shared modal chrome, two dialogs never gated shortcuts. */
export function useModalGate(): void {
  onMounted(pushModal);
  onUnmounted(popModal);
}

// Live under every modal: the Announcer (Teleported to body) keeps speaking, and toasts paint above the overlay
// (z-index 2500 over 1000), so their action buttons stay clickable.
const ALWAYS_LIVE = ["#a11y-announcer", ".toast-stack"];

type Layer = { el: HTMLElement; keep: string[] };
const layers: Layer[] = [];
// Only what this helper marked, so an element bound :inert elsewhere (App.vue under Home) is never cleared here.
const marked = new Map<HTMLElement, { aria: boolean }>();

/** Makes everything outside `el` inert until the returned release runs, since WebKit screen readers ignore
 *  aria-modal and would browse the page behind. Stacks: the newest connected layer wins, and releasing it hands
 *  the page back to the one under it. `keep` lists selectors that stay live too, such as Home's own toggle. */
export function inertOthers(el: HTMLElement, keep: string[] = []): () => void {
  const layer: Layer = { el, keep };
  layers.push(layer);
  applyInert();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
    applyInert();
  };
}

/** How many modal layers hold the page inert right now. */
export function inertDepth(): number {
  return layers.length;
}

function applyInert(): void {
  for (const [n, how] of marked) {
    n.removeAttribute("inert");
    if (how.aria) n.removeAttribute("aria-hidden");
  }
  marked.clear();
  let top: Layer | undefined;
  for (let i = layers.length - 1; i >= 0 && !top; i--) if (layers[i]?.el.isConnected) top = layers[i];
  if (!top) return;
  const live = new Set<Element>([top.el]);
  for (const sel of [...ALWAYS_LIVE, ...top.keep]) for (const n of document.querySelectorAll(sel)) live.add(n);
  const path = new Set<Element>();
  for (const n of live) for (let p: Element | null = n; p && p !== document.body; p = p.parentElement) path.add(p);
  hideBesides(document.body, live, path);
}

function hideBesides(parent: Element, live: Set<Element>, path: Set<Element>): void {
  for (const child of parent.children) {
    if (live.has(child)) continue;
    if (path.has(child)) hideBesides(child, live, path);
    else if (child instanceof HTMLElement && !child.hasAttribute("inert") && !NO_MARK.has(child.tagName)) {
      child.setAttribute("inert", "");
      // Note: inert alone is enough on current WebKit, aria-hidden covers an older WebKitGTK that predates it.
      const aria = !child.hasAttribute("aria-hidden");
      if (aria) child.setAttribute("aria-hidden", "true");
      marked.set(child, { aria });
    }
  }
}

const NO_MARK = new Set(["SCRIPT", "STYLE", "TEMPLATE", "LINK", "META", "NOSCRIPT"]);
