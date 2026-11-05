import { ref, type Ref } from "vue";

/** Cues for a strip that scrolls with its scrollbar hidden: whether more sits above or below, a page step for the cue
 *  buttons, and a focusin handler so a focused control honours the strip's scroll-padding and stays clear of them. */
export function useScrollCue(el: Readonly<Ref<HTMLElement | null>>) {
  const above = ref(false);
  const below = ref(false);
  function update() {
    const e = el.value;
    above.value = !!e && e.scrollTop > 1;
    below.value = !!e && e.scrollTop + e.clientHeight < e.scrollHeight - 1;
  }
  function page(dir: 1 | -1) {
    const e = el.value;
    if (!e) return;
    e.scrollTop += dir * Math.max(1, Math.round(e.clientHeight * 0.75));
    update();
  }
  function reveal(ev: FocusEvent) {
    const t = ev.target;
    if (t instanceof HTMLElement && t !== el.value) t.scrollIntoView?.({ block: "nearest" });
  }
  return { above, below, update, page, reveal };
}
