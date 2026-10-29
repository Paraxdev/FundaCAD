const COMMAND = String.fromCharCode(0x2318);
const OPTION = String.fromCharCode(0x2325);
const CONTROL = String.fromCharCode(0x2303);

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
 *  stay in Ctrl and Alt, the names the matchers and the plugin remap use; Control is the literal macOS Control key. */
export function fmtKeys(text: string): string {
  if (!isMac()) return text;
  return text
    .replace(/\bCtrl\b/g, COMMAND)
    .replace(/\bAlt\b/g, OPTION)
    .replace(/\bControl(?=\+)/g, CONTROL);
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

/** The key of a Ctrl or Cmd chord: latinKey, except that a digit row key gives its digit, Shift held or not (Shift+1
 *  types ! on a US layout, and AZERTY types & for an unshifted 1). */
export function comboKey(e: { key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }) {
  const d = /^Digit(\d)$/.exec(e.code ?? "");
  if (d && (e.ctrlKey || e.metaKey) && !e.altKey) return d[1]!;
  return latinKey(e);
}

export type ChordId = "items" | "history" | "console";

/** Window level chords, in the table language: Ctrl is Cmd on macOS, Control the literal macOS Control key. The first
 *  of a platform is its hint. macOS drops Cmd+Option+H (Hide Others) and Cmd+` (the window switch). */
export const CHORDS: Record<ChordId, { pc: readonly string[]; mac: readonly string[] }> = {
  items: { pc: ["Ctrl+Alt+S", "Ctrl+Shift+1"], mac: ["Ctrl+Shift+1"] },
  history: { pc: ["Ctrl+Alt+H", "Ctrl+Shift+2"], mac: ["Ctrl+Shift+2"] },
  console: { pc: ["Ctrl+`"], mac: ["Control+`"] },
};

type KeyInit = {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
};

function chordMatches(chord: string, e: KeyInit): boolean {
  const parts = chord.split("+");
  const key = parts.pop()!;
  const has = (m: string) => parts.includes(m);
  if (has("Control") ? !e.ctrlKey || e.metaKey : has("Ctrl") !== !!(e.ctrlKey || e.metaKey)) return false;
  if (has("Shift") !== !!e.shiftKey || has("Alt") !== !!e.altKey) return false;
  if (/^\d$/.test(key)) return e.code === `Digit${key}`;
  if (key === "`") return e.key === "`" || e.code === "Backquote";
  return latinKey(e) === key.toLowerCase();
}

/** The chords of one action on this platform. */
export function chordsOf(id: ChordId): readonly string[] {
  return CHORDS[id][isMac() ? "mac" : "pc"];
}

/** The chord a keydown presses on this platform, or null. */
export function matchChord(e: KeyInit): ChordId | null {
  for (const id of Object.keys(CHORDS) as ChordId[]) if (chordsOf(id).some((c) => chordMatches(c, e))) return id;
  return null;
}

/** The chord an action shows, in the table language for a keys prop. */
export function chordKeys(id: ChordId): string {
  return chordsOf(id)[0]!;
}

/** The chord an action shows, as the platform writes it. */
export function chordHint(id: ChordId): string {
  return fmtKeys(chordKeys(id));
}
