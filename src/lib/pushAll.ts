/** `into.push(...from)` without passing every element as an argument, which
 *  throws RangeError once `from` has more than about 120k entries. */
export function pushAll<T>(into: T[], from: ArrayLike<T>): void {
  for (let i = 0; i < from.length; i++) into.push(from[i]!);
}
