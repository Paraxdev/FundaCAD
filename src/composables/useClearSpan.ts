import { onMounted, onUnmounted, type Ref } from "vue";
import { COLUMNS, LEFT_CARDS, RIGHT_CARDS, cardRects, centreShift, promptInsets } from "../ui/promptPlacement";

/** Sets --span-left, --span-right and --span-shift so `el`, laid out as the prompt is, keeps to the stretch of its own
 *  row no floating card covers and lines up with the prompt on the middle of the view as far as that stretch allows. */
export function useClearSpan(el: Readonly<Ref<HTMLElement | null>>) {
  let frame = 0;
  let ro: ResizeObserver | null = null;
  const watched = new Set<Element>();

  const watchAll = () => {
    for (const n of [el.value, el.value?.parentElement, ...document.querySelectorAll(COLUMNS)]) {
      if (!n || watched.has(n)) continue;
      watched.add(n);
      ro?.observe(n);
    }
  };

  // Even an unchanged write restyles every glass panel the readout sits over.
  const put = (me: HTMLElement, name: string, px: number) => {
    if (me.style.getPropertyValue(name) !== `${px}px`) me.style.setProperty(name, `${px}px`);
  };

  const place = () => {
    const me = el.value;
    const area = me?.parentElement;
    if (!me || !area) return;
    watchAll();
    const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--float-gap")) || 12;
    const box = area.getBoundingClientRect();
    const mine = me.getBoundingClientRect();
    const cards = { left: cardRects(LEFT_CARDS), right: cardRects(RIGHT_CARDS) };
    const insets = promptInsets(box, mine, cards, gap, mine.width);
    put(me, "--span-left", insets.left);
    put(me, "--span-right", insets.right);
    put(me, "--span-shift", centreShift(box.width, insets, mine.width));
  };

  const schedule = () => {
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
  };
  // A rail scrolled by a step shows other labels in the row without resizing anything.
  const onScroll = (e: Event) => {
    if (e.target instanceof Element && e.target.closest("#float-layer")) schedule();
  };

  onMounted(() => {
    ro = new ResizeObserver(schedule);
    watchAll();
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    schedule();
  });
  onUnmounted(() => {
    ro?.disconnect();
    watched.clear();
    document.removeEventListener("scroll", onScroll, { capture: true });
    if (frame) cancelAnimationFrame(frame);
  });
}
