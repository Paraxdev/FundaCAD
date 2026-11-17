// Lines the app writes in English because the build state and the MCP tools carry them (src/document/facelessBodies.ts,
// src/geometry/client.ts, the parameter engine's refusals in src/params), or for the console detail beside a worded
// toast (the sketch dimension editor). Each pattern is made from the English line itself, so rewording one cannot drift.

import { t, tEnglish, type MessageArgs, type MessageKey } from "../i18n";

interface Form {
  key: MessageKey;
  fixed?: MessageArgs;
  numbers?: readonly string[];
  texts?: readonly string[];
}

const arity = (form: string, numbers: readonly string[]): Form => ({
  key: "expr.arity",
  fixed: { form },
  numbers,
  texts: ["name"],
});

const FORMS: readonly Form[] = [
  { key: "document.faceless", fixed: { far: "yes" } },
  { key: "document.faceless", fixed: { far: "no" } },
  { key: "engine.tooLarge", numbers: ["size", "limit"] },
  { key: "engine.tooLargeRefused" },
  { key: "field.problem.unknownName", texts: ["name"] },
  { key: "field.problem.invalidNumber", texts: ["number"] },
  { key: "field.problem.selfReference", texts: ["name"] },
  { key: "field.problem.circular" },
  { key: "field.problem.circularVia", texts: ["chain"] },
  { key: "field.problem.unitless" },
  { key: "field.problem.noFiniteValue" },
  { key: "field.problem.invalidExpression" },
  { key: "field.problem.targetGone" },
  { key: "field.problem.nameChars" },
  { key: "field.problem.reservedName", texts: ["name"] },
  { key: "field.problem.nameTaken", texts: ["name"] },
  { key: "field.problem.modelNames" },
  { key: "params.referencedBy", texts: ["name", "refs"] },
  { key: "field.problem.invalidValue" },
  { key: "field.problem.noDocument" },
  { key: "field.problem.notPositive" },
  { key: "field.problem.notEditable" },
  { key: "field.problem.noEntity" },
  { key: "field.problem.noExpressionHere" },
  { key: "expr.tooLong", numbers: ["max"] },
  { key: "expr.tooDeep", numbers: ["max"] },
  { key: "expr.qualifiedName" },
  { key: "expr.commaInCall" },
  { key: "expr.unexpectedCharacter", texts: ["char"] },
  { key: "expr.empty" },
  { key: "expr.unchained" },
  { key: "expr.unexpectedEnd" },
  { key: "expr.missingParen" },
  { key: "expr.missingParenIn", texts: ["name"] },
  { key: "expr.unexpected", texts: ["token"] },
  { key: "expr.notYet", texts: ["name"] },
  { key: "expr.unknownFunction", texts: ["name"] },
  arity("atLeast", ["lo"]),
  arity("range", ["lo", "hi"]),
  arity("one", []),
  arity("other", ["lo"]),
];

// Below 1000, so English writes them with no group separator.
const MARK = 901;
// A private use character stands for a text argument, so escaping leaves it alone.
const TEXT = "\uE000";

interface Pattern {
  form: Form;
  re: RegExp;
  order: { name: string; text: boolean }[];
}

let patterns: Pattern[] | null = null;

function compile(form: Form): Pattern {
  const names = form.numbers ?? [];
  const texts = form.texts ?? [];
  const english = tEnglish(form.key, {
    ...form.fixed,
    ...Object.fromEntries(names.map((n, i) => [n, MARK + i])),
    ...Object.fromEntries(texts.map((n, i) => [n, `${TEXT}${i}${TEXT}`])),
  });
  const order: Pattern["order"] = [];
  const source = english
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(new RegExp(`${TEXT}(\\d+)${TEXT}|\\b90\\d\\b`, "g"), (m, i?: string) => {
      if (i !== undefined) {
        order.push({ name: texts[Number(i)]!, text: true });
        return "(.*)";
      }
      order.push({ name: names[Number(m) - MARK]!, text: false });
      return "([0-9][0-9,]*)";
    });
  return { form, re: new RegExp(`^${source}$`), order };
}

/** The key and arguments of a line the app wrote in English, null for any other line. */
export function englishLine(line: string): { key: MessageKey; args: MessageArgs } | null {
  for (const { form, re, order } of (patterns ??= FORMS.map(compile))) {
    const m = re.exec(line);
    if (!m) continue;
    const args: MessageArgs = { ...form.fixed };
    order.forEach(({ name, text }, i) => (args[name] = text ? m[i + 1]! : Number(m[i + 1]!.replace(/,/g, ""))));
    return { key: form.key, args };
  }
  return null;
}

/** The line in the chosen language when the app wrote it in English for the build state, any other line as it is. */
export function shownLine(line: string): string {
  const said = englishLine(line);
  return said ? t(said.key, said.args) : line;
}
