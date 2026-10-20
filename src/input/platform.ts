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

/** A key hint as the platform writes it: Command and Option glyphs on macOS,
 *  Ctrl and Alt elsewhere. The hint tables stay written with Ctrl and Alt, the
 *  names the matchers and the plugin remap use, and are translated where shown. */
export function fmtKeys(text: string): string {
  if (!isMac()) return text;
  return text.replace(/\bCtrl\b/g, COMMAND).replace(/\bAlt\b/g, OPTION);
}
