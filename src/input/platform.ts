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

const ARIA_MODIFIERS: Record<string, string> = {
  ctrl: "Control",
  control: "Control",
  cmd: "Meta",
  command: "Meta",
  meta: "Meta",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};
const ARIA_NAMED: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  del: "Delete",
  delete: "Delete",
  ins: "Insert",
  insert: "Insert",
  return: "Enter",
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  home: "Home",
  end: "End",
  pgup: "PageUp",
  pageup: "PageUp",
  pgdn: "PageDown",
  pagedown: "PageDown",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
};

function ariaCombo(text: string): string | null {
  const t = text.trim();
  const parts = t.endsWith("++") ? [...t.slice(0, -2).split(/[+\s]+/), "+"] : t.split(/[+\s]+/);
  const key = parts.pop() ?? "";
  const mods: string[] = [];
  for (const p of parts) {
    const m = ARIA_MODIFIERS[p.toLowerCase()];
    if (!m) return null;
    mods.push(p.toLowerCase() === "ctrl" && isMac() ? "Meta" : m);
  }
  const named = ARIA_NAMED[key.toLowerCase()] ?? (/^F([1-9]|1\d|2[0-4])$/i.test(key) ? key.toUpperCase() : null);
  const k = named ?? ([...key].length === 1 ? key.toUpperCase() : null);
  return k ? [...mods, k].join("+") : null;
}

/** A keys hint (or a list of them) as aria-keyshortcuts wants it: Ctrl is Control, or Meta on macOS, Esc is Escape,
 *  alternatives written "A / B" are space separated. A hint that is no key (a drag, "Arrows") is left out. */
export function ariaKeys(keys: string | readonly string[] | undefined): string | undefined {
  const list = typeof keys === "string" ? [keys] : (keys ?? []);
  const out = list.flatMap((k) => k.split(/\s+\/\s+/)).map(ariaCombo);
  const ok = out.filter((c): c is string => !!c);
  return ok.length ? [...new Set(ok)].join(" ") : undefined;
}

const SPOKEN_MAC: Record<string, string> = { Meta: "Command", Alt: "Option" };
const SPOKEN_NAMED: Record<string, string> = {
  ArrowUp: "Up arrow",
  ArrowDown: "Down arrow",
  ArrowLeft: "Left arrow",
  ArrowRight: "Right arrow",
  PageUp: "Page up",
  PageDown: "Page down",
  ",": "comma",
  ".": "period",
  "/": "slash",
  "\\": "backslash",
  ";": "semicolon",
  "'": "quote",
  "[": "left bracket",
  "]": "right bracket",
  "`": "backtick",
  "-": "minus",
  "=": "equals",
  "?": "question mark",
  "+": "plus",
};

/** A keys hint as a screen reader says it: Control, Alt and Shift, or Command, Option, Control and Shift on macOS,
 *  punctuation as words (a voice at a low punctuation level skips it), alternatives joined by "or". */
export function spokenKeys(keys: string | readonly string[] | undefined): string {
  const list = typeof keys === "string" ? [keys] : (keys ?? []);
  return list
    .flatMap((k) => k.split(/\s+\/\s+/))
    .map((k) => {
      const c = ariaCombo(k);
      if (!c) return k.trim();
      const parts = c.endsWith("++") ? [...c.slice(0, -2).split("+"), "+"] : c.split("+");
      return parts.map((p) => (isMac() ? SPOKEN_MAC[p] : undefined) ?? SPOKEN_NAMED[p] ?? p).join(" ");
    })
    .filter(Boolean)
    .join(" or ");
}
