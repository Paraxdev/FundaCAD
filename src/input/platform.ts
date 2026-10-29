const COMMAND = String.fromCharCode(0x2318);
const OPTION = String.fromCharCode(0x2325);

let forced: boolean | null = null;

/** Test seam: true or false pins the platform, null goes back to detection. */
export function setMacForTest(mac: boolean | null) {
  forced = mac;
}

export function isMac(): boolean {
  if (forced !== null) return forced;
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac/i.test(nav.userAgentData?.platform || nav.platform || "");
}

/** A key hint as the platform writes it: Command and Option glyphs on macOS, Ctrl and Alt elsewhere. The tables
 *  stay in Ctrl and Alt, the names the matchers and the plugin remap use. */
export function fmtKeys(text: string): string {
  if (!isMac()) return text;
  return text.replace(/\bCtrl\b/g, COMMAND).replace(/\bAlt\b/g, OPTION);
}

export type ZoomChord = "up" | "down" | "reset";

/** The Interface size keys: Cmd on macOS, Ctrl elsewhere, with Plus, Minus or 0. Alt held is never one, since AltGr
 *  reports Ctrl+Alt on Windows. Digit0 covers layouts that shift the 0; Numpad0 counts only as a typed 0, as with
 *  Num Lock off it is Insert and Ctrl+Insert copies. */
export function zoomChord(
  ev: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey">,
): ZoomChord | null {
  const held = isMac() ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && !ev.metaKey;
  if (!held || ev.altKey) return null;
  if (ev.key === "+" || ev.key === "=" || ev.code === "NumpadAdd") return "up";
  if (ev.key === "-" || ev.code === "NumpadSubtract") return "down";
  if (ev.key === "0" || ev.code === "Digit0") return "reset";
  return null;
}
