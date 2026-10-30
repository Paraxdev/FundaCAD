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

const TOUCH = ":root[data-pointer=touch] ";
const LARGE = ":root[data-targets=large] ";
const FINGER = /(?:^|;)\s*(?:opacity|visibility|transform):/;

/** Touch rules with no Larger click targets twin in the same rule, and finger only rules (opacity,
 *  visibility, transform) that have one, each by its selector after the root. */
export function touchTwins(css: string): { untwinned: string[]; fingerTwinned: string[] } {
  const untwinned = new Set<string>();
  const fingerTwinned = new Set<string>();
  for (const { selectors, body } of rules(css)) {
    const finger = FINGER.test(body);
    for (const s of selectors) {
      if (!s.startsWith(TOUCH)) continue;
      const tail = s.slice(TOUCH.length);
      const twinned = selectors.includes(LARGE + tail);
      if (finger && twinned) fingerTwinned.add(tail);
      if (!finger && !twinned) untwinned.add(tail);
    }
  }
  return { untwinned: [...untwinned].sort(), fingerTwinned: [...fingerTwinned].sort() };
}
