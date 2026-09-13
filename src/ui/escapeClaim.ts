// A menu or popover that is open owns the next Escape.
//
// Every Escape listener sits on window in the capture phase, so they run in the
// order they were added, and a tool attached before the menu opened hears the key
// first. stopImmediatePropagation cannot reach back to it, so those listeners ask
// here instead.

let claims = 0;

/** Claim Escape while an overlay is open. The release lands after the current
 *  event, so the Escape that closes the overlay still counts as claimed for the
 *  listeners that run after the overlay's own. */
export function claimEscape(): () => void {
  claims++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    setTimeout(() => { claims--; }, 0);
  };
}

export function escapeClaimed(): boolean {
  return claims > 0;
}
