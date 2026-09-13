/** A fingerprint of a string: two independent 32-bit mixes and the length. It
 *  tells versions and linked files apart; it is not a security digest. */
export function contentHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b + c, 0x5bd1e995) >>> 0;
    b = (b << 13) | (b >>> 19);
  }
  return `${a.toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}${text.length.toString(16)}`;
}
