// Battery and a minimised window, the two things the page's visibility state
// does not tell the tracer. Both are best effort: getBattery is missing outside
// Chromium, and a desktop without a battery reports charging.

export interface PowerState {
  discharging: boolean;
  minimised: boolean;
}

interface BatteryLike {
  charging: boolean;
  addEventListener(type: "chargingchange", cb: () => void): void;
}

export function watchPower(cb: (p: PowerState) => void): void {
  const st: PowerState = { discharging: false, minimised: false };
  const emit = () => cb({ ...st });
  try {
    const nav = globalThis.navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
    void nav.getBattery?.()
      .then((b) => {
        const read = () => {
          st.discharging = !b.charging;
          emit();
        };
        b.addEventListener("chargingchange", read);
        read();
      })
      .catch(() => {});
  } catch { /* blocked by a permissions policy */ }
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  // WebView2 skips SetIsVisible on a minimise, so visibilityState can stay
  // "visible" while nobody can see the window.
  void import("@tauri-apps/api/window")
    .then(async ({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      const read = async () => {
        const m = await w.isMinimized();
        if (m === st.minimised) return;
        st.minimised = m;
        emit();
      };
      await w.onResized(() => void read().catch(() => {}));
      await read();
    })
    .catch(() => {});
}
