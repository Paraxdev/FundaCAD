import { onMounted, onUnmounted, type Ref } from "vue";
import { LEFT_CARDS, RIGHT_CARDS, clearRow, promptInsets, type Box } from "../ui/promptPlacement";

const COLUMNS =
  "#float-layer .float-left, #float-layer .float-left-stack, #float-layer .tool-rail, #float-layer .float-right";

const rects = (sel: string): Box[] => [...document.querySelectorAll(sel)].map((o) => o.getBoundingClientRect());

// Layout sizes, not getBoundingClientRect: a child's entrance animation scales it, and nothing re-measures after.
const natural = (me: HTMLElement) => ({
  width: Math.max(0, ...[...me.children].map((c) => (c as HTMLElement).offsetWidth)),
  height: me.offsetHeight,
});

/** Sets --row-top, --row-left and --row-right on `el` to keep it clear of the floating cards: the top row, else the
 *  top row with `data-narrow` set (its children drop their words), else the first row down with room, else the top
 *  row narrow and over what it must cover, as the prompt does. */
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
    const root = getComputedStyle(document.documentElement);
    const gap = parseFloat(root.getPropertyValue("--float-gap")) || 12;
    const box = area.getBoundingClientRect();
    const first = box.top + (parseFloat(root.getPropertyValue("--s-4")) || 16);
    const cards = { left: rects(LEFT_CARDS), right: rects(RIGHT_CARDS) };
    const rowWhen = (narrow: boolean) => {
      me.toggleAttribute("data-narrow", narrow);
      return clearRow(box, natural(me), first, cards, gap);
    };
    const whole = rowWhen(false);
    let row = whole;
    let narrow = false;
    if (whole?.top !== first) {
      const tight = rowWhen(true);
      narrow = tight?.top === first || !whole;
      if (tight?.top === first) row = tight;
    }
    me.toggleAttribute("data-narrow", narrow);
    row ??= { top: first, ...promptInsets(box, { top: first, bottom: first + me.offsetHeight }, cards, gap, minWidth) };
    me.style.setProperty("--row-top", `${row.top - box.top}px`);
    me.style.setProperty("--row-left", `${row.left}px`);
    me.style.setProperty("--row-right", `${row.right}px`);
  };

  const schedule = () => {
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
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
