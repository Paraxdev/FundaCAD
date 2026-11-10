// Pseudo text for finding cut labels and strings that skip the lookup: accented, about 1.7 times English, between
// brackets, so a missing closing bracket means cut and plain letters mean not converted.

import type { MessageNode } from "./format";

// Latin-1 only: the self hosted fonts are the Latin subset, so these letters render in the real UI font.
const ACCENTS: Record<string, string> = {
  a: "á",
  c: "ç",
  e: "é",
  i: "í",
  n: "ñ",
  o: "ö",
  u: "ü",
  y: "ý",
  A: "Å",
  C: "Ç",
  E: "É",
  I: "Î",
  N: "Ñ",
  O: "Ö",
  U: "Ü",
  Y: "Ý",
};

function stretch(text: string): string {
  let out = "";
  for (const ch of text) {
    const accented = ACCENTS[ch];
    out += accented ? accented + accented : ch;
  }
  // Short labels grow the most in real translations, so each word also gets a tail.
  return out.replace(/\p{L}{3,}/gu, (word) => `${word}${word.slice(-1)}`);
}

function mapNodes(nodes: readonly MessageNode[]): MessageNode[] {
  return nodes.map((node) => {
    if (node.t === "text") return { t: "text", v: stretch(node.v) };
    if (node.t === "plural" || node.t === "select") {
      const options = new Map<string, MessageNode[]>();
      for (const [key, value] of node.options) options.set(key, mapNodes(value));
      return { ...node, options };
    }
    return node;
  });
}

export function pseudoNodes(nodes: readonly MessageNode[]): MessageNode[] {
  return [{ t: "text", v: "[" }, ...mapNodes(nodes), { t: "text", v: "]" }];
}
