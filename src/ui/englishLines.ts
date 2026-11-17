// Lines the app writes in English because the build state and the MCP tools carry them (src/document/facelessBodies.ts,
// src/geometry/client.ts). Each pattern is made from the English line itself, so rewording one cannot drift.

import { t, tEnglish, type MessageArgs, type MessageKey } from "../i18n";

interface Form {
  key: MessageKey;
  fixed?: MessageArgs;
  numbers?: readonly string[];
}

const FORMS: readonly Form[] = [
  { key: "document.faceless", fixed: { far: "yes" } },
  { key: "document.faceless", fixed: { far: "no" } },
  { key: "engine.tooLarge", numbers: ["size", "limit"] },
  { key: "engine.tooLargeRefused" },
];

// Below 1000, so English writes them with no group separator.
const MARK = 901;

interface Pattern {
  form: Form;
  re: RegExp;
  order: string[];
}

let patterns: Pattern[] | null = null;

function compile(form: Form): Pattern {
  const names = form.numbers ?? [];
  const english = tEnglish(form.key, { ...form.fixed, ...Object.fromEntries(names.map((n, i) => [n, MARK + i])) });
  const order: string[] = [];
  let source = english.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (names.length)
    source = source.replace(/\b90\d\b/g, (m) => {
      order.push(names[Number(m) - MARK]!);
      return "([0-9][0-9,]*)";
    });
  return { form, re: new RegExp(`^${source}$`), order };
}

/** The line in the chosen language when the app wrote it in English for the build state, any other line as it is. */
export function shownLine(line: string): string {
  for (const { form, re, order } of (patterns ??= FORMS.map(compile))) {
    const m = re.exec(line);
    if (!m) continue;
    const args: MessageArgs = { ...form.fixed };
    order.forEach((name, i) => (args[name] = Number(m[i + 1]!.replace(/,/g, ""))));
    return t(form.key, args);
  }
  return line;
}
