// A subset of ICU MessageFormat: {name}, {n, number}, plural and select. It interprets a parsed tree and never
// builds code, so a dropped in line can only ever come out as text.

export type MessageNode =
  | { t: "text"; v: string }
  | { t: "arg"; name: string; number: boolean }
  | { t: "pound" }
  | { t: "plural"; name: string; options: Map<string, MessageNode[]> }
  | { t: "select"; name: string; options: Map<string, MessageNode[]> };

export type MessageArgs = Record<string, string | number>;
export type DecimalMark = "." | ",";

export class MessageSyntaxError extends Error {}

const NAME = /[A-Za-z_][A-Za-z0-9_]*/y;
const OPTION_KEY = /=?[A-Za-z0-9_]+/y;
const PLURAL_KEY = /^(zero|one|two|few|many|other|=\d+)$/;

export function parseMessage(src: string): MessageNode[] {
  let i = 0;

  const fail = (why: string): never => {
    throw new MessageSyntaxError(`${why} at ${i} in "${src}"`);
  };
  const skipSpace = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  const match = (re: RegExp): string | null => {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  const expect = (ch: string) => {
    skipSpace();
    if (src[i] !== ch) fail(`expected ${ch}`);
    i++;
  };

  function nodes(inPlural: boolean, nested: boolean): MessageNode[] {
    const out: MessageNode[] = [];
    let text = "";
    const flush = () => {
      if (text) out.push({ t: "text", v: text });
      text = "";
    };
    while (i < src.length) {
      const c = src[i]!;
      if (c === "'") {
        const next = src[i + 1];
        if (next === "'") {
          text += "'";
          i += 2;
        } else if (next === "{" || next === "}" || (inPlural && next === "#")) {
          // ICU quotes only before syntax, so French l'appui needs no doubling.
          const end = src.indexOf("'", i + 1);
          if (end < 0) fail("unclosed quote");
          text += src.slice(i + 1, end);
          i = end + 1;
        } else {
          text += "'";
          i++;
        }
      } else if (c === "{") {
        flush();
        i++;
        out.push(argument(inPlural));
      } else if (c === "}") {
        if (!nested) fail("stray }");
        break;
      } else if (c === "#" && inPlural) {
        flush();
        i++;
        out.push({ t: "pound" });
      } else {
        text += c;
        i++;
      }
    }
    flush();
    return out;
  }

  function options(plural: boolean, inPlural: boolean): Map<string, MessageNode[]> {
    const out = new Map<string, MessageNode[]>();
    for (;;) {
      skipSpace();
      if (src[i] === "}") break;
      const key = match(OPTION_KEY) ?? fail("expected an option");
      // A typo such as `on` would otherwise never be chosen and fall to other without a word.
      if (plural && !PLURAL_KEY.test(key)) fail(`unknown plural category ${key}`);
      expect("{");
      out.set(key, nodes(inPlural, true));
      expect("}");
    }
    if (!out.has("other")) fail("an option list needs other");
    return out;
  }

  function argument(inPlural: boolean): MessageNode {
    skipSpace();
    const name = match(NAME) ?? fail("expected an argument name");
    skipSpace();
    if (src[i] === "}") {
      i++;
      return { t: "arg", name, number: false };
    }
    expect(",");
    skipSpace();
    const kind = match(NAME);
    skipSpace();
    if (kind === "number") {
      expect("}");
      return { t: "arg", name, number: true };
    }
    if (kind !== "plural" && kind !== "select") return fail(`unknown kind ${kind ?? ""}`);
    expect(",");
    const plural = kind === "plural";
    const opts = options(plural, plural || inPlural);
    expect("}");
    return { t: kind, name, options: opts };
  }

  return nodes(false, false);
}

const numberFormats = new Map<string, Intl.NumberFormat>();
const pluralRules = new Map<string, Intl.PluralRules>();
const warnedMissing = new Set<string>();

function formatNumber(n: number, locale: string): string {
  let f = numberFormats.get(locale);
  // No grouping: German 210.000 reads as 210 beside a value box, and value boxes do not group either.
  if (!f) numberFormats.set(locale, (f = new Intl.NumberFormat(locale, { useGrouping: false })));
  return f.format(n);
}

const decimalMarks = new Map<string, DecimalMark>();

// An unsupported tag would make Intl use the PC's own locale, so lookup decides first. A third mark (Arabic) reads as a point, the only two the readers know.
export function decimalMarkOf(tag: string): DecimalMark {
  let mark = decimalMarks.get(tag);
  if (mark) return mark;
  mark = ".";
  try {
    if (Intl.NumberFormat.supportedLocalesOf([tag], { localeMatcher: "lookup" }).length > 0) {
      const part = new Intl.NumberFormat(tag).formatToParts(1.5).find((p) => p.type === "decimal");
      if (part?.value === ",") mark = ",";
    }
  } catch {
    // a malformed tag keeps the point
  }
  decimalMarks.set(tag, mark);
  return mark;
}

function pluralCategory(n: number, locale: string): string {
  let r = pluralRules.get(locale);
  if (!r) pluralRules.set(locale, (r = new Intl.PluralRules(locale)));
  return r.select(n);
}

function pluralCount(name: string, args: MessageArgs): number {
  const v = args[name];
  if (v !== undefined) return Number(v);
  if (import.meta.env.DEV && !warnedMissing.has(name)) {
    warnedMissing.add(name);
    console.warn(`message plural {${name}} was given no count, it reads as 0`);
  }
  return 0;
}

export function formatMessage(
  nodes: readonly MessageNode[],
  args: MessageArgs,
  locale: string,
  pound?: number,
  plurals = locale,
): string {
  let out = "";
  for (const node of nodes) {
    switch (node.t) {
      case "text":
        out += node.v;
        break;
      case "pound":
        out += pound === undefined ? "#" : formatNumber(pound, locale);
        break;
      case "arg": {
        const v = args[node.name];
        if (v === undefined) out += `{${node.name}}`;
        else out += node.number && typeof v === "number" ? formatNumber(v, locale) : String(v);
        break;
      }
      case "plural": {
        const n = pluralCount(node.name, args);
        const chosen = node.options.get(`=${n}`) ?? node.options.get(pluralCategory(n, plurals));
        out += formatMessage(chosen ?? node.options.get("other")!, args, locale, n, plurals);
        break;
      }
      case "select": {
        const chosen = node.options.get(String(args[node.name])) ?? node.options.get("other")!;
        out += formatMessage(chosen, args, locale, pound, plurals);
        break;
      }
    }
  }
  return out;
}

/** So a translation or a dropped in line cannot ask for a value the code never passes. */
export function argNames(nodes: readonly MessageNode[], into = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (node.t === "arg") into.add(node.name);
    else if (node.t === "plural" || node.t === "select") {
      into.add(node.name);
      for (const option of node.options.values()) argNames(option, into);
    }
  }
  return into;
}
