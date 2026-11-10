// A decimal comma typed in a language that writes one, turned into the point the grammar of parse.ts reads. The swap
// keeps the length, so error positions stay right.

const DIGIT = /[0-9]/;
const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

/** A comma is a decimal mark when a digit follows it and it starts a number or continues one. After a name or a
 *  closing bracket it stays, so the tokenizer refuses it. A doubtful number (1,5,5) becomes one the grammar refuses. */
export function commasToPoints(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < text.length && IDENT_PART.test(text[j]!)) j++;
      out += text.slice(i, j);
      i = j;
    } else if (DIGIT.test(ch)) {
      let j = i + 1;
      for (;;) {
        while (j < text.length && DIGIT.test(text[j]!)) j++;
        if ((text[j] === "," || text[j] === ".") && DIGIT.test(text[j + 1] ?? "")) j++;
        else break;
      }
      out += text.slice(i, j).replace(/,/g, ".");
      i = j;
    } else if (ch === "," && DIGIT.test(text[i + 1] ?? "") && !/[A-Za-z0-9_)]/.test(text[i - 1] ?? "")) {
      out += ".";
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}
