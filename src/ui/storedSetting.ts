// Reads a setting under its current name, then under older names from the renames, copying a found value forward.
// The old value stays, so moving back to an older build still finds it.

/** Pass names newest first: someone two renames behind has the value only under the oldest key. Null when no name
 *  holds anything. Safe without `localStorage`, as in the headless suites. */
export function readSetting(key: string, ...legacy: string[]): string | null {
  if (typeof localStorage === "undefined") return null;
  const current = localStorage.getItem(key);
  if (current !== null) return current;
  for (const name of legacy) {
    const old = localStorage.getItem(name);
    if (old === null) continue;
    try {
      localStorage.setItem(key, old);
    } catch {
      // A full or blocked store still has the value in hand; the copy is an
      // optimisation, not the point.
    }
    return old;
  }
  return null;
}
