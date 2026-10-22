import { onMounted, onUnmounted, type Ref } from "vue";
import { LEFT_CARDS, RIGHT_CARDS, promptInsets, type Box } from "../ui/promptPlacement";

const COLUMNS = "#float-layer .float-left, #float-layer .float-left-stack, #float-layer .tool-rail, #float-layer .float-right";

const rects = (sel: string): Box[] => [...document.querySelectorAll(sel)].map((o) => o.getBoundingClientRect());

/** Sets --row-left and --row-right on `el`: the insets from its parent's sides that keep its row clear of the
 *  floating cards, as the prompt does. */
export function useClearOfCards(el: Readonly<Ref<HTMLElement | null>>, minWidth = 160) {
  let frame = 0;
  let ro: ResizeObserver | null = null;
  const watched = new Set<Element>();

  // The columns may mount after this element, so each pass picks up the ones not yet observed.
  const watchAll = () => {
    for (const n of [el.value, el.value?.parentElement, ...document.querySelectorAll(COLUMNS)]) {
      if (!n || watched.has(n)) continue;
      watched.add(n);
      ro?.observe(n);
    }
  };

  const place = () => {
    const me = el.value;
    const area = me?.parentElement;
    if (!me || !area) return;
    watchAll();
    const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--float-gap")) || 12;
    const { left, right } = promptInsets(
      area.getBoundingClientRect(),
      me.getBoundingClientRect(),
      { left: rects(LEFT_CARDS), right: rects(RIGHT_CARDS) },
      gap,
      minWidth,
    );
    me.style.setProperty("--row-left", `${left}px`);
    me.style.setProperty("--row-right", `${right}px`);
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; place(); });
  };

  onMounted(() => {
    ro = new ResizeObserver(schedule);
    watchAll();
    schedule();
  });
  onUnmounted(() => {
    ro?.disconnect();
    watched.clear();
    if (frame) cancelAnimationFrame(frame);
  });
}
