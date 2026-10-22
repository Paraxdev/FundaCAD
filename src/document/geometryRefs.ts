const HASH = /^[0-9a-f]{32}$/;

// BLAKE2b-128 lowercase hex. An unknown feature type may name a blob in any field, so a save embeds what the store has.
export function hashShapedStrings(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    if (value.length === 32 && HASH.test(value)) out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) hashShapedStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) hashShapedStrings(v, out);
  }
  return out;
}
