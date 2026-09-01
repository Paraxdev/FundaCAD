// Reading a user setting that has been stored under more than one name.
//
// The settings modules (theme, icons, units, layoutPrefs, browserFilter,
// welcome, recentFiles, printerClient, spacemouse) each keep one localStorage
// key, read once at module load. Renaming those keys during the rebrand would
// silently reset every one of them: the app would find nothing under the new
// name and fall back to its default, which reads as "it forgot my settings"
// rather than as an upgrade.
//
// So reads look under the new name first and the old name second, and a value
// found under the old name is copied forward. The old value is LEFT in place: it
// costs a few bytes, nothing reads it once the copy exists, and removing it
// would strand anyone who moved back to an older build partway through.
//
// One helper rather than nine open-coded fallbacks, because the failure here is
// silent — a key that got renamed in one place and not the other loses a setting
// with no error anywhere — and one helper is one thing to get right and one
// thing to test.

/** The stored value for `key`, migrating a value found under an older name.
 *
 *  VARIADIC because there has now been more than one rename, and a chain has to
 *  reach all the way back: someone who last opened the app two names ago has
 *  their theme under the oldest key and nothing at all under the newer two, and
 *  a single fallback would look one step behind and give up. Tried newest
 *  first, which is also the order they should be passed in — the first one that
 *  holds anything wins, so a stale value from three names ago cannot outrank a
 *  fresher one.
 *
 *  Returns null when no name holds anything, which every caller already treats
 *  as "use the default". Safe where `localStorage` does not exist, which is how
 *  the headless suites reach these modules.
 */
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
