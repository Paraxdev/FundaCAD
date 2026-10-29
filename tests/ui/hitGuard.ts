export type Rule = { selectors: string[]; body: string };

const normal = (selector: string) =>
  selector
    .trim()
    .replace(/\s+/g, " ")
    .replace(/="([\w-]+)"\]/g, "=$1]");

/** Every innermost rule of compiled CSS, at-rule bodies included, comments dropped. */
export function rules(css: string): Rule[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selectors: (m[1] ?? "").split(",").map(normal), body: m[2] ?? "" }))
    .filter(({ selectors }) => !selectors[0]?.startsWith("@"));
}

/** The value of `prop` in the rules for exactly `selector`, the last one winning, or undefined. */
export function valueOf(css: string, selector: string, prop: string): string | undefined {
  const want = normal(selector);
  let found: string | undefined;
  for (const { selectors, body } of rules(css)) {
    if (!selectors.includes(want)) continue;
    for (const decl of body.split(";")) {
      const at = decl.indexOf(":");
      if (at > 0 && decl.slice(0, at).trim() === prop) found = decl.slice(at + 1).trim();
    }
  }
  return found;
}

const HIT_INSET = /(?:^|;)\s*inset:[^;]*var\(--hit-min\)/;

/** The hosts with no ::before or ::after hit area: a positioned pseudo inset by var(--hit-min). */
export function missingHitAreas(css: string, hosts: readonly string[]): string[] {
  const grown = new Set<string>();
  for (const { selectors, body } of rules(css)) {
    if (!HIT_INSET.test(body) || !/content:/.test(body) || !/position:\s*absolute/.test(body)) continue;
    for (const s of selectors) {
      const m = /^(.*)::(?:before|after)$/.exec(s);
      if (m?.[1]) grown.add(m[1]);
    }
  }
  return hosts.filter((host) => !grown.has(normal(host)));
}
