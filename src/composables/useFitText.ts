import { nextTick, onMounted, onUnmounted, watch, type WatchSource } from "vue";

/** The factor that shrinks a line of `natural` width into `room`; it never grows one. */
export function fitScale(room: number, natural: number): number {
  if (!(room > 0) || !(natural > room)) return 1;
  return Math.floor((room / natural) * 1000) / 1000;
}

/** Shrink to fit: sets `prop`, a unitless --*-scale the box's CSS multiplies into its font size, so the one line
 *  `label` fits the box's content width. Measured at full size, so the rounded widths cannot make it oscillate. */
export function useFitText(
  box: () => HTMLElement | null | undefined,
  label: () => HTMLElement | null | undefined,
  prop: `--${string}-scale`,
  text: WatchSource<string>,
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
    const room = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const scale = fitScale(room, line.scrollWidth);
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
