import { onMounted, onUnmounted, ref, type Ref } from "vue";

/** Whether `query` matches now, false in a webview without matchMedia. */
export function useMediaQuery(query: string): Ref<boolean> {
  const list = typeof matchMedia === "function" ? matchMedia(query) : null;
  const matches = ref(list?.matches ?? false);
  const sync = (e: { matches: boolean }) => (matches.value = e.matches);
  onMounted(() => {
    // WKWebView before Safari 14 (macOS 10.15) has only the older addListener on a MediaQueryList.
    if (typeof list?.addEventListener === "function") list.addEventListener("change", sync);
    else list?.addListener?.(sync);
  });
  onUnmounted(() => {
    if (typeof list?.removeEventListener === "function") list.removeEventListener("change", sync);
    else list?.removeListener?.(sync);
  });
  return matches;
}
