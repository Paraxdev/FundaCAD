// An open menu or popover owns the next Escape. Window capture listeners run in the order added, so a tool attached
// earlier hears the key first and stopImmediatePropagation cannot reach it; those listeners ask here instead.

let claims = 0;

/** The release lands after the current event, so the Escape that closes the overlay still counts as claimed for the
 *  listeners after the overlay's own. */
export function claimEscape(): () => void {
  claims++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    setTimeout(() => {
      claims--;
    }, 0);
  };
}

export function escapeClaimed(): boolean {
  return claims > 0;
}
