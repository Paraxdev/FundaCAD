import { onMounted, onUnmounted, type Ref } from "vue";

// WebKitGTK quirk: wheel events over an overflow panel do not reliably reach the native scroller (kinetic scrolling
// eats them), so the scroll is driven here, deltaMode-normalized. Bound by hand because it must be non-passive.
export function useWheelScroll(scroller: Readonly<Ref<HTMLElement | null>>) {
  function onWheel(ev: WheelEvent) {
    const el = scroller.value;
    if (!el || el.scrollHeight <= el.clientHeight) return;
    const step = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 100 : 1;
    el.scrollTop += ev.deltaY * step;
    ev.preventDefault();
  }
  onMounted(() => scroller.value?.addEventListener("wheel", onWheel, { passive: false }));
  onUnmounted(() => scroller.value?.removeEventListener("wheel", onWheel));
}
