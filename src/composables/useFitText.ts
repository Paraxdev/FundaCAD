import { nextTick, onMounted, onUnmounted, watch, type WatchSource } from "vue";

/** The smallest share of its size a fitted reading shrinks to; past it the box grows instead, so it stays readable. */
export const MIN_FIT_SCALE = 0.75;

/** The factor that shrinks a line of `natural` width into `room`, never under `floor` and never above 1. */
export function fitScale(room: number, natural: number, floor = MIN_FIT_SCALE): number {
  if (!(room > 0) || !(natural > room)) return 1;
  return Math.max(floor, Math.floor((room / natural) * 1000) / 1000);
}

/** Shrink to fit: sets `prop`, a unitless --*-scale the box's CSS multiplies into its font size, so the one line
 *  `label` fits the box's min-width less its padding and border. A box sized by its content then keeps that width until the
 *  floor, and grows past it. Measured at full size, so the rounded widths cannot make it oscillate. */
export function useFitText(
  box: () => HTMLElement | null | undefined,
  label: () => HTMLElement | null | undefined,
  prop: `--${string}-scale`,
  text: WatchSource<string>,
  floor = MIN_FIT_SCALE,
) {
  let ro: ResizeObserver | null = null;
  let watched: HTMLElement | null = null;

  const fit = () => {
    const el = box();
    const line = label();
    if (!el || !line) return;
    if (line !== watched) {
      if (watched) ro?.unobserve(watched);
      watched = line;
      ro?.observe(line);
    }
    el.style.setProperty(prop, "1");
    const cs = getComputedStyle(el);
    const px = (v: string) => parseFloat(v) || 0;
    const room =
      px(cs.minWidth) - px(cs.paddingLeft) - px(cs.paddingRight) - px(cs.borderLeftWidth) - px(cs.borderRightWidth);
    const scale = fitScale(room, line.scrollWidth, floor);
    if (scale === 1) el.style.removeProperty(prop);
    else el.style.setProperty(prop, String(scale));
  };

  watch(text, () => void nextTick(fit));
  onMounted(() => {
    if (typeof ResizeObserver !== "undefined") ro = new ResizeObserver(() => fit());
    fit();
    void document.fonts?.ready.then(fit);
  });
  onUnmounted(() => {
    ro?.disconnect();
    ro = null;
  });
}
