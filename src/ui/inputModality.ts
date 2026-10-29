/** Whether the last input was a key or a pointer, so a popup opened by keyboard can take focus and one opened by a
 *  click leaves it on its opener. Not :focus-visible, because WKWebView does not focus a clicked button. */
export type InputModality = "keyboard" | "pointer";

let last: InputModality = "pointer";
const watched = new WeakSet<EventTarget>();

const onKey = () => (last = "keyboard");
const onPointer = () => (last = "pointer");
// A click with no press count came from Enter, Space or a screen reader's default action, never from a real pointer.
const onClick = (e: Event) => {
  if ((e as MouseEvent).detail === 0) last = "keyboard";
};

const EVENTS: [string, (e: Event) => void][] = [
  ["keydown", onKey],
  ["pointerdown", onPointer],
  ["mousedown", onPointer],
  ["click", onClick],
];

/** Starts tracking on `target` (the window by default, already done on import), once per target. */
export function trackInputModality(target: EventTarget): () => void {
  if (watched.has(target)) return () => {};
  watched.add(target);
  const opts = { capture: true, passive: true };
  for (const [type, fn] of EVENTS) target.addEventListener(type, fn, opts);
  return () => {
    watched.delete(target);
    for (const [type, fn] of EVENTS) target.removeEventListener(type, fn, opts);
  };
}

export function inputModality(): InputModality {
  return last;
}

export function setInputModalityForTest(m: InputModality): void {
  last = m;
}

if (typeof window !== "undefined") trackInputModality(window);
