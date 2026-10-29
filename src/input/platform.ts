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

const PUNCTUATION: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Backslash: "\\",
};

/** The key a shortcut matches, lower case. A letter of a non Latin script (Cyrillic, Greek, Hebrew, Arabic) or a non
 *  ASCII digit gives way to the US key under it, so E and Ctrl+Z work on a Russian layout. Latin layouts keep what
 *  they type (AZERTY a stays a), and so do Alt and AltGr, whose letters are meant (Polish AltGr+S is s acute). */
export function latinKey(e: { key: string; code?: string; altKey?: boolean }): string {
  const k = e.key.toLowerCase();
  const foreign = (/^\p{L}$/u.test(k) && !/\p{Script=Latin}/u.test(k)) || (/^\p{Nd}$/u.test(k) && !/^\d$/.test(k));
  if (e.altKey || !e.code || !foreign) return k;
  const m = /^(?:Key([A-Z])|Digit(\d))$/.exec(e.code);
  if (m) return (m[1] ?? m[2] ?? "").toLowerCase();
  return PUNCTUATION[e.code] ?? k;
}
