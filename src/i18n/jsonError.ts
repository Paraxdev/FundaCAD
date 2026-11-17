export interface TextPosition {
  line: number;
  column: number;
}

// JSON.parse names no position in WebKit, and its position text differs between engines, so the first character that
// breaks the JSON grammar is found here. Returns its index, the text length for a file that ends too soon, or null.
export function jsonErrorIndex(s: string): number | null {
  const n = s.length;
  const at = (k: number) => s.charAt(k);
  let i = 0;
  const ws = () => {
    while (i < n && (at(i) === " " || at(i) === "\t" || at(i) === "\n" || at(i) === "\r")) i++;
  };
  const fail = (at: number): never => {
    throw at;
  };
  const digits = () => {
    if (!(at(i) >= "0" && at(i) <= "9")) fail(i);
    while (at(i) >= "0" && at(i) <= "9") i++;
  };
  const string = () => {
    i++;
    for (;;) {
      if (i >= n) fail(n);
      const c = at(i);
      if (c === '"') return void i++;
      if (c < " ") fail(i);
      if (c !== "\\") {
        i++;
        continue;
      }
      const e = at(i + 1);
      if (e === "u") {
        for (let k = 2; k < 6; k++) if (!/[0-9a-fA-F]/.test(at(i + k))) fail(Math.min(i + k, n));
        i += 6;
      } else if (e !== "" && '"\\/bfnrt'.includes(e)) i += 2;
      else fail(Math.min(i + 1, n));
    }
  };
  const value = (): void => {
    ws();
    const c = at(i);
    if (c === "{") {
      i++;
      ws();
      if (at(i) === "}") return void i++;
      for (;;) {
        ws();
        if (at(i) !== '"') fail(i);
        string();
        ws();
        if (at(i) !== ":") fail(i);
        i++;
        value();
        ws();
        if (at(i) === ",") i++;
        else if (at(i) === "}") return void i++;
        else fail(i);
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (at(i) === "]") return void i++;
      for (;;) {
        value();
        ws();
        if (at(i) === ",") i++;
        else if (at(i) === "]") return void i++;
        else fail(i);
      }
    }
    if (c === '"') return string();
    for (const word of ["true", "false", "null"]) {
      if (c !== word[0]) continue;
      for (let k = 1; k < word.length; k++) if (at(i + k) !== word[k]) fail(Math.min(i + k, n));
      return void (i += word.length);
    }
    if (c === "-") i++;
    if (at(i) === "0") i++;
    else digits();
    if (at(i) === ".") {
      i++;
      digits();
    }
    if (at(i) === "e" || at(i) === "E") {
      i++;
      if (at(i) === "+" || at(i) === "-") i++;
      digits();
    }
  };
  try {
    value();
    ws();
    return i < n ? i : null;
  } catch (e) {
    return typeof e === "number" ? e : null;
  }
}

// Counts characters, as an editor's status bar does, and a lone CR, CRLF or LF each end one line.
export function positionOf(s: string, index: number): TextPosition {
  let line = 1;
  let column = 1;
  for (let i = 0; i < index; i++) {
    const c = s.charAt(i);
    if (c === "\n" || (c === "\r" && s.charAt(i + 1) !== "\n")) {
      line++;
      column = 1;
    } else if (c !== "\r" && !(c >= "\udc00" && c <= "\udfff")) column++;
  }
  return { line, column };
}
