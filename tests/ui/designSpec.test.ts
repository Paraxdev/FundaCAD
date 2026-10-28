// The guard behind docs/DESIGN.md. It cannot see a screen, so it holds the rules
// a reviewer misses most: colours come from the tokens, blur comes from the glass,
// no new flat slab or hard shadow appears, no rounded surface wears an outline,
// the light theme's text reads on its fills, and every token a rule reads exists.
//
// Sources come through Vite (import.meta.glob with ?raw), so the test needs no
// node types. vitest.config.ts lets ?raw through for .scss, or it hands back "".

import { describe, expect, it } from "vitest";
import { themes, type ShippedTheme } from "../../src/ui/theme";

const read = (files: Record<string, string>) =>
  new Map(Object.entries(files).map(([path, text]) => [path.replace(/^(\.\.\/)+/, ""), text]));

const vueFiles = read(
  import.meta.glob("../../src/components/**/*.vue", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >,
);
const scssFiles = read(
  import.meta.glob("../../src/styles/*.scss", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >,
);

// The base component partials. Their selectors nest in SCSS, which the selector rules below do not read, so they are
// held to the colour, token and motion rules only.
const uiScssFiles = read(
  import.meta.glob("../../src/styles/ui/*.scss", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >,
);

const tsFiles = read(
  import.meta.glob("../../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
);

const TOKENS = "src/styles/_tokens.scss";
const GLASS = "src/styles/_glass.scss";

// The colour literals each file holds today. A file not listed starts at zero.
// The count must match exactly, so a cleanup lowers the number in the same commit
// and the ratchet never leaves room for new literals.
const COLOUR_BASELINE: Record<string, number> = {
  "src/components/overlays/PluginSettingsForm.vue": 2,
  "src/components/overlays/RadialMenuHost.vue": 2,
  "src/components/shell/NumberBox.vue": 2,
  "src/components/shell/SurfaceNodeEditor.vue": 11,
  "src/styles/_browser.scss": 4,
  "src/styles/_console.scss": 2,
  "src/styles/_float.scss": 5,
  "src/styles/_glass.scss": 3,
  "src/styles/_inspector.scss": 11,
  "src/styles/_layout.scss": 3,
  "src/styles/_modals.scss": 71,
  "src/styles/_notice.scss": 1,
  "src/styles/_renderdock.scss": 5,
  "src/styles/_targetedit.scss": 2,
  "src/styles/_timeline.scss": 5,
  "src/styles/_utilities.scss": 2,
};

// Declarations, outside a hover, press, focus or selected rule, that fill with
// --panel, --panel-2, --raised or --raised-2, or cast --shadow-1/2/3. That is how
// the flat Home was built. Most of these are flat bases _glass.scss repaints,
// inset wells or title bar chrome. Exact counts, as above: a new floating surface
// goes on the _glass.scss lists instead of raising a number here.
const FLAT_BASELINE: Record<string, number> = {
  "src/components/overlays/FilletMembers.vue": 1,
  "src/styles/_browser.scss": 3,
  "src/styles/_console.scss": 2,
  "src/styles/_float.scss": 2,
  "src/styles/_glass.scss": 2,
  "src/styles/_inspector.scss": 1,
  "src/styles/_layout.scss": 1,
  "src/styles/_modals.scss": 19,
  "src/styles/_palette.scss": 2,
  "src/styles/_prefs.scss": 1,
  "src/styles/_renderdock.scss": 8,
  "src/styles/_targetedit.scss": 2,
  "src/styles/_timeline.scss": 6,
  "src/styles/_titlebar.scss": 4,
  "src/styles/_utilities.scss": 12,
};

// Blurs written by hand outside _glass.scss. Anything new uses var(--float-blur),
// which html.no-glass-blur can switch off and the theme can tune in one place.
const BLUR_ALLOWED: Record<string, { count: number; reason: string }> = {
  "src/styles/_console.scss": { count: 2, reason: "base of .logcon, repainted by _glass.scss" },
  "src/styles/_modals.scss": {
    count: 3,
    reason: "base of .choice-backdrop and .cmdk-backdrop, repainted by _glass.scss",
  },
  "src/styles/_targetedit.scss": { count: 2, reason: "base of .tgt-panel, repainted by _glass.scss" },
  "src/styles/_utilities.scss": { count: 2, reason: "base of .prompt, repainted by #viewport .prompt in _glass.scss" },
};

// Read but defined nowhere, so they fall back or paint nothing. Shrink this list,
// never grow it: --danger is --error, --fg is --text, --muted is --text-mute,
// --border is --line, --panel-1 and --bg-panel are --panel,
// --fg-dim is --text-dim.
const UNDEFINED_ALLOWED = [
  "--danger",
  "--fg",
  "--border",
  "--muted",
  "--bg-panel",
  "--bg-sunken",
  "--fg-dim",
  "--panel-1",
];

function styleOf(path: string, text: string): string {
  const css = path.endsWith(".vue")
    ? [...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n")
    : text;
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function declarations(css: string): { prop: string; value: string }[] {
  return [...css.matchAll(/(?:^|[{;])\s*(-{0,2}[a-zA-Z][\w-]*)\s*:\s*([^;{}]*)(?=[;}])/gm)].map((m) => ({
    prop: (m[1] ?? "").toLowerCase(),
    value: m[2] ?? "",
  }));
}

const HEX = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
const COLOUR_FN = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;
const NAMED = /(?<![\w-])(?:white|black|red|green|blue|gray|grey|orange|yellow|purple|pink)(?![\w-])/gi;

const colours = (value: string) =>
  (value.match(HEX)?.length ?? 0) + (value.match(COLOUR_FN)?.length ?? 0) + (value.match(NAMED)?.length ?? 0);

function colourLiterals(path: string, text: string): number {
  return declarations(styleOf(path, text)).reduce((n, { value }) => n + colours(value), 0);
}

const STATE =
  /:hover|:active|:focus|:checked|:disabled|\.(?:active|on|selected|open|holding|disabled)(?![\w-])|\[aria-/;
const FLAT_FILL = /^var\(--(?:panel|panel-2|raised|raised-2)(?:\s*,[^)]*)?\)$/;
const HARD_SHADOW = /var\(--shadow-[123](?![\w-])/;

function flatSurfaces(path: string, text: string): string[] {
  return [...styleOf(path, text).matchAll(/([^{};]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: (m[1] ?? "").trim().replace(/\s+/g, " "), body: m[2] ?? "" }))
    .filter(({ selector }) => !selector.startsWith("@") && !STATE.test(selector))
    .flatMap(({ selector, body }) =>
      declarations(`{${body}}`)
        .filter(
          ({ prop, value }) =>
            ((prop === "background" || prop === "background-color") && FLAT_FILL.test(value.trim())) ||
            (prop === "box-shadow" && HARD_SHADOW.test(value)),
        )
        .map(() => selector),
    );
}

function handBlurs(path: string, text: string): string[] {
  return declarations(styleOf(path, text))
    .filter(({ prop }) => prop === "backdrop-filter" || prop === "-webkit-backdrop-filter")
    .map(({ value }) => value.trim())
    .filter((value) => value !== "var(--float-blur)" && value !== "none");
}

const FALLBACK = /var\(\s*--[\w-]+\s*,/;
const LITERAL_TIME =
  /(?<![\w.-])(?:\d*\.)?\d+m?s(?![\w-])|(?<![\w-])(?:ease(?:-in|-out|-in-out)?|linear|cubic-bezier\()(?![\w-])/;
const LITERAL_RADIUS = /(?<![\w.-])(?:\d*\.)?[1-9]\d*(?:px|rem|em)(?![\w-])/;

// What in a base partial is not read from a token: a colour, a fallback, a duration or easing, a radius of its own.
function untokened(path: string, text: string): string[] {
  return declarations(styleOf(path, text))
    .filter(
      ({ prop, value }) =>
        colours(value) > 0 ||
        FALLBACK.test(value) ||
        (/^(transition|animation)(-duration|-delay|-timing-function)?$/.test(prop) && LITERAL_TIME.test(value)) ||
        (/radius$/.test(prop) && LITERAL_RADIUS.test(value) && !value.includes("var(--")),
    )
    .map(({ prop, value }) => `${prop}: ${value.trim()}`);
}

function names(text: string, re: RegExp): Set<string> {
  return new Set([...text.matchAll(re)].map((m) => m[1] ?? ""));
}

const sources = new Map([...vueFiles, ...scssFiles]);
const styled = new Map([...sources, ...uiScssFiles]);
const tokens = names(scssFiles.get(TOKENS) ?? "", /(--[\w-]+)\s*:/g);
// Set where it is used: an inline :style, a setProperty, a local declaration, in a template, a
// stylesheet or a TypeScript module (homeBackground.ts sets --home-image).
const local = new Set(
  [...styled.values(), ...tsFiles.values()].flatMap((t) => [
    ...names(t, /['"`](--[\w-]+)['"`]/g),
    ...names(t, /(?<![\w(-])(--[\w-]+)\s*:/g),
  ]),
);

// Depth comes from fill and shadow, never from a line around a rounded surface. A surface is rounded when any rule
// gives its last compound (state stripped) a radius or a squircle; an outline is a visible full border, a border
// colour, an outline outside focus, or a 0 0 0 Npx ring. Focus outlines and these readings may keep their line.
const OUTLINE_ALLOWED: { selector: RegExp; reason: string }[] = [
  { selector: /\.sketch-dim|\.sketch-glyph|\.rel-sym/, reason: "a sketch label or constraint symbol tells its state" },
  { selector: /\.versions-dot|\.updating-spin|\.profile-track-knob|\.ne-dot/, reason: "a drawn glyph, the ring is it" },
  { selector: /\.guide-ring/, reason: "the guide points at a control with a ring" },
  {
    selector: /swatch|\.rd-ball|\.bug-shot-saved img/,
    reason: "a swatch, material ball or screenshot keeps its edge on any fill",
  },
];
// An error or warning may flag a field with its colour.
const SIGNAL = /var\(--(?:error|warn|error-tint)\)|#ff6b6b|#e0a020|#d2a83b|rgba\(255, 107, 107,/;

function splitSelectors(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of selector) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

function rulesOf(path: string, text: string): { selectors: string[]; decls: { prop: string; value: string }[] }[] {
  return [...styleOf(path, text).matchAll(/([^{};]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: (m[1] ?? "").trim().replace(/\s+/g, " "), body: m[2] ?? "" }))
    .filter(({ selector }) => !selector.startsWith("@"))
    .map(({ selector, body }) => ({
      selectors: splitSelectors(selector),
      decls: declarations(`{${body}}`).map(({ prop, value }) => ({ prop, value: value.replace(/\s+/g, " ").trim() })),
    }));
}

// The surface a selector paints is the first name in its last compound: `.rail-btn.active .rail-tile` paints a
// .rail-tile, `.context-tab.sketch` a .context-tab, whatever state or variant class follows.
const surfaceOf = (selector: string) =>
  /^[#.]?[\w-]+/.exec(
    selector
      .replace(/::?(?:before|after)$/, "")
      .split(/[\s>+~]+/)
      .pop() ?? "",
  )?.[0] ?? "";

const NO_PAINT = /(^|\s)(none|hidden|transparent)$|^none\b|^0(px)?(\s|$)/;

// Splits a value on spaces that sit outside parentheses.
function words(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of value) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === " " && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

const ZERO = /^[+-]?0*\.?0+(px|em|rem)?$/;
const LENGTH = /^[+-]?(\d+\.?\d*|\.\d+)(px|em|rem)?$/;

// A shadow that draws a line round the box: no offset, a blur of 1px at most, and a spread (a number or a
// variable, which may hold one).
function isRingShadow(shadow: string): boolean {
  const w = words(shadow.trim()).filter((x) => x !== "inset");
  const [x = "", y = "", blur = "", spread = ""] = w;
  if (!ZERO.test(x) || !ZERO.test(y) || !spread) return false;
  const thin = ZERO.test(blur) || (LENGTH.test(blur) && Number.parseFloat(blur) <= 1);
  return thin && ((LENGTH.test(spread) && !ZERO.test(spread)) || /^var\(/.test(spread));
}

function isOutline(prop: string, value: string): boolean {
  if (prop === "border" || prop === "border-color" || prop === "outline" || prop === "outline-color") {
    return !NO_PAINT.test(value);
  }
  if (prop === "border-style") return !/^(none|hidden)$/.test(value);
  if (prop === "border-image" || prop === "border-image-source") return !/^none\b/.test(value);
  // A mask that cuts the middle out of an ::after paints a ring.
  if (prop === "mask-composite" || prop === "-webkit-mask-composite") return /xor|exclude/.test(value);
  return prop === "box-shadow" && splitSelectors(value).some(isRingShadow);
}

// Only a real :focus or :focus-visible state is exempt. :focus-within and :not(:focus) are not.
const isFocusState = (selector: string) => /:focus(?:-visible)?(?![\w-])/.test(selector.replace(/:not\([^)]*\)/g, ""));

const STATE_CLASSES = new Set(["on", "active", "selected", "open", "disabled", "holding", "typed", "shown", "busy"]);

type Compound = { tag: string; ids: string[]; classes: string[] };
function compoundOf(selector: string): Compound {
  const last = (
    selector
      .replace(/::?(?:before|after)$/, "")
      .split(/[\s>+~]+/)
      .pop() ?? ""
  ).replace(/\[[^\]]*\]|:[\w-]+(\([^)]*\))?/g, "");
  return {
    tag: /^[a-z][\w-]*/i.exec(last)?.[0] ?? "",
    ids: [...last.matchAll(/#([\w-]+)/g)].map((m) => m[1] ?? ""),
    classes: [...last.matchAll(/\.([\w-]+)/g)].map((m) => m[1] ?? ""),
  };
}

// The static class lists the templates write, with the tag that carries them.
function classGroups(templates: Iterable<string>): { tag: string; classes: Set<string> }[] {
  return [...templates].flatMap((text) =>
    [...text.matchAll(/<([\w-]+)\s[^>]*?(?<![:@\w-])class="([^"{}]*)"/g)].map((m) => ({
      tag: m[1] ?? "",
      classes: new Set((m[2] ?? "").split(/\s+/).filter(Boolean)),
    })),
  );
}

function outlinedSurfaces(files: Iterable<[string, string]>, templates: Iterable<string> = []): string[] {
  const rules = [...files].flatMap(([path, text]) => rulesOf(path, text).map((r) => ({ path, ...r })));
  const groups = classGroups(templates);
  const rounds = (d: { prop: string; value: string }) =>
    (d.prop === "border-radius" && !/^0(px)?$/.test(d.value)) || d.prop === "corner-shape";
  const rounded = new Set(rules.filter((r) => r.decls.some(rounds)).flatMap((r) => r.selectors.map(surfaceOf)));
  const rounders = rules.filter((r) => r.decls.some(rounds)).flatMap((r) => r.selectors.map(compoundOf));
  // Whether a rule that rounds some element can land on the element this selector paints: the classes the
  // templates give that element are taken from the lists that hold its own (non state) classes.
  const roundedByOther = (selector: string) => {
    const mine = compoundOf(selector);
    const core = mine.classes.filter((c) => !STATE_CLASSES.has(c));
    const own = groups.filter((g) => core.length > 0 && core.every((c) => g.classes.has(c)));
    const classes = new Set([...mine.classes, ...own.flatMap((g) => [...g.classes])]);
    const tags = new Set([mine.tag, ...own.map((g) => g.tag)].filter(Boolean));
    return rounders.some(
      (r) =>
        (r.classes.length > 0 || r.ids.length > 0 || r.tag !== "") &&
        r.ids.every((i) => mine.ids.includes(i)) &&
        r.classes.every((c) => classes.has(c)) &&
        (r.tag === "" || tags.has(r.tag)),
    );
  };
  return rules.flatMap(({ path, selectors, decls }) =>
    selectors
      .filter((s) => !isFocusState(s) && !OUTLINE_ALLOWED.some((a) => a.selector.test(s)))
      .filter((s) => rounded.has(surfaceOf(s)) || decls.some(rounds) || roundedByOther(s))
      .flatMap((s) =>
        decls
          .filter(({ prop, value }) => isOutline(prop, value) && !SIGNAL.test(value))
          .map(({ prop, value }) => `${path} ${s} { ${prop}: ${value} }`),
      ),
  );
}

// Retired with the outlined glass: defined, transparent, for plugin stylesheets, and read by no core rule.
const RETIRED = ["--float-line", "--glass-sheen", "--glass-inset", "--glass-rim", "--accent-glow"];

type Rgba = [number, number, number, number];

function parseColour(value: string): Rgba {
  const v = value.trim();
  if (v === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = Number.parseInt(hex[1] ?? "", 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (fn) {
    const [r = NaN, g = NaN, b = NaN, a = 1] = (fn[1] ?? "").split(",").map(Number);
    return [r, g, b, a];
  }
  throw new Error(`not a colour: ${value}`);
}

// color-mix in srgb with premultiplied alpha, as the browser does it.
function mixColours(a: Rgba, p: number, b: Rgba): Rgba {
  const alpha = a[3] * p + b[3] * (1 - p);
  if (alpha === 0) return [0, 0, 0, 0];
  const ch = (i: 0 | 1 | 2) => (a[i] * a[3] * p + b[i] * b[3] * (1 - p)) / alpha;
  return [ch(0), ch(1), ch(2), alpha];
}

function resolveColour(value: string, vars: Record<string, string>): Rgba {
  const v = value.trim();
  const token = /^var\((--[\w-]+)\)$/.exec(v);
  if (token) return resolveColour(vars[token[1] ?? ""] ?? `missing ${token[1]}`, vars);
  const cm = /^color-mix\(in srgb,\s*(.+)\)$/.exec(v);
  if (cm) {
    const [left = "", right = ""] = splitSelectors(cm[1] ?? "");
    const pct = /\s(\d+(?:\.\d+)?)%$/.exec(left);
    const p = pct ? Number(pct[1]) / 100 : 0.5;
    return mixColours(resolveColour(left.replace(/\s\d+(?:\.\d+)?%$/, ""), vars), p, resolveColour(right, vars));
  }
  return parseColour(v);
}

const over = (top: Rgba, under: Rgba): Rgba => mixColours([top[0], top[1], top[2], 1], top[3], under);

function contrastRatio(fg: Rgba, bg: Rgba): number {
  const lum = ([r, g, b]: Rgba) => {
    const lin = (c: number) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const [x, y] = [lum(fg), lum(bg)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function block(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return {};
  const body = css.slice(at + selector.length + 2, css.indexOf("}", at));
  return Object.fromEntries(
    declarations(`{${body}}`).map(({ prop, value }) => [prop, value.replace(/\s+/g, " ").trim()]),
  );
}

// Everything the Preferences dialog renders: its own file and the components it imports, followed down.
function renderedBy(root: string, files: Map<string, string>): string[] {
  const seen = new Set<string>();
  const walk = (path: string) => {
    if (seen.has(path) || !files.has(path)) return;
    seen.add(path);
    const dir = path.slice(0, path.lastIndexOf("/"));
    for (const m of (files.get(path) ?? "").matchAll(/^import\s+\w+\s+from\s+"(\.{1,2}\/[^"]+\.vue)";/gm)) {
      const parts = `${dir}/${m[1]}`.split("/");
      const out: string[] = [];
      for (const part of parts) {
        if (part === "..") out.pop();
        else if (part !== ".") out.push(part);
      }
      walk(out.join("/"));
    }
  };
  walk(root);
  return [...seen];
}

// A settings page toggles with the Checkbox (.check); a switch is for a live toggle in a tool panel.
const switchesIn = (files: Map<string, string>, paths: string[]) =>
  paths.filter((path) =>
    /class="[^"]*\b(?:param-switch|ft-switch|ui-switch)\b|<(?:ToggleRow|Toggle|Switch|SwitchRow)\b/.test(
      files.get(path) ?? "",
    ),
  );

// The background a typed field inside a .dim-bad box ends up with: of the rules that name only those
// classes, the most specific wins, and the later one on a tie.
function errorFill(files: [string, string][]): string {
  let best = { weight: -1, value: "" };
  for (const [path, text] of files)
    for (const { selectors, decls } of rulesOf(path, text))
      for (const s of selectors) {
        const parts = s.split(/\s+/);
        const last = parts.pop() ?? "";
        const classes = last.split(".").filter(Boolean);
        if (
          !/^(\.[\w-]+)+$/.test(last) ||
          !classes.includes("dim-field") ||
          classes.some((c) => c !== "dim-field" && c !== "typed")
        )
          continue;
        if (parts.some((p) => p !== ".dim-bad")) continue;
        const weight = classes.length + parts.length;
        const fill = decls.filter(({ prop }) => prop === "background" || prop === "background-color").pop();
        if (fill && weight >= best.weight) best = { weight, value: fill.value };
      }
  return best.value;
}

describe("design spec guard", () => {
  it("reads the sources", () => {
    expect(vueFiles.size).toBeGreaterThan(50);
    expect(scssFiles.size).toBeGreaterThan(15);
    expect(uiScssFiles.size).toBeGreaterThan(15);
    for (const [path, text] of styled) expect(text.length, path).toBeGreaterThan(0);
    expect(tokens.has("--float-blur")).toBe(true);
    expect(tokens.has("--accent")).toBe(true);
  });

  it("adds no raw colour literal to a component or stylesheet", () => {
    const changed = [...styled]
      .filter(([path]) => path !== TOKENS)
      .map(([path, text]) => ({ path, count: colourLiterals(path, text), baseline: COLOUR_BASELINE[path] ?? 0 }))
      .filter(({ count, baseline }) => count !== baseline);
    // Above the baseline: use var(--token), or color-mix(in srgb, var(--token) N%, transparent),
    // see docs/DESIGN.md, Tokens. Below it: lower the number in COLOUR_BASELINE.
    expect(changed).toEqual([]);
  });

  it("adds no flat slab or hard shadow", () => {
    const changed = [...sources]
      .map(([path, text]) => ({ path, selectors: flatSurfaces(path, text), baseline: FLAT_BASELINE[path] ?? 0 }))
      .filter(({ selectors, baseline }) => selectors.length !== baseline);
    // Above the baseline: a floating surface is glass, so reuse a glass class or add the selector
    // to the lists in _glass.scss, see docs/DESIGN.md, The glass recipe. Below it: lower FLAT_BASELINE.
    expect(changed).toEqual([]);
  });

  it("blurs only through the glass", () => {
    const loose = [...sources]
      .filter(([path]) => path !== TOKENS && path !== GLASS)
      .map(([path, text]) => ({ path, blurs: handBlurs(path, text) }))
      .filter(({ path, blurs }) => blurs.length > (BLUR_ALLOWED[path]?.count ?? 0));
    // Reuse a glass class or add the selector to a list in _glass.scss. See docs/DESIGN.md, The glass recipe.
    expect(loose).toEqual([]);
  });

  it("reads only tokens that exist", () => {
    const missing = [...styled]
      .flatMap(([path, text]) => [...names(text, /var\(\s*(--[\w-]+)/g)].map((name) => ({ path, name })))
      .filter(({ name }) => !tokens.has(name) && !local.has(name) && !UNDEFINED_ALLOWED.includes(name));
    expect(missing).toEqual([]);
  });

  it("styles the base components with tokens only", () => {
    // A base partial starts and stays at zero: the ratchet has no room for it.
    expect(Object.keys(COLOUR_BASELINE).filter((path) => uiScssFiles.has(path))).toEqual([]);
    expect([...uiScssFiles].flatMap(([path, text]) => untokened(path, text).map((d) => `${path} ${d}`))).toEqual([]);
  });

  it("puts no outline around a rounded surface", () => {
    // Tell a surface apart by its fill (--float-tile-bg, --float-chip-bg, --field-bg) and the shadow, and state by a
    // fill or wash, see docs/DESIGN.md, Depth without lines.
    expect(outlinedSurfaces(sources, vueFiles.values())).toEqual([]);
  });

  it("shows an error on a dimension field while it is typed in", () => {
    const main = scssFiles.get("src/styles/main.scss") ?? "";
    const order = [...main.matchAll(/@use "([\w-]+)"/g)].map((m) => `src/styles/_${m[1]}.scss`);
    expect(order).toContain(GLASS);
    expect(errorFill(order.map((path) => [path, scssFiles.get(path) ?? ""]))).toContain("--error-tint");
    // A later rule that repaints the typed field loses the error.
    expect(
      errorFill([
        ["a.scss", ".dim-bad .dim-field { background: var(--error-tint); }"],
        ["b.scss", ".dim-field.typed { background: var(--float-chip-bg); }"],
      ]),
    ).not.toContain("--error-tint");
  });

  it("reads none of the retired glass tokens, and keeps each one invisible", () => {
    const root = block(styleOf(TOKENS, scssFiles.get(TOKENS) ?? ""), ":root");
    for (const name of RETIRED)
      expect(root[name], name).toMatch(
        /^(transparent|linear-gradient\(transparent, transparent\)|0 0 transparent|rgba\([\d, ]+, 0\))$/,
      );
    const readers = [...sources].flatMap(([path, text]) =>
      RETIRED.filter((name) => styleOf(path, text).includes(`var(${name})`)).map((name) => `${path} ${name}`),
    );
    expect(readers).toEqual([]);
  });

  it("keeps the accent calm: no glow, a light saturate on the blur", () => {
    const root = block(styleOf(TOKENS, scssFiles.get(TOKENS) ?? ""), ":root");
    expect(root["--float-blur"]).toMatch(/saturate\(1(\.0\d+)?\)$/);
    expect(root["--accent"]).toBe("#9a9ff0");
  });

  it("reads every light theme text token at 4.5:1 or better on each fill it sits on", () => {
    const css = styleOf(TOKENS, scssFiles.get(TOKENS) ?? "");
    const light = themes().find((t) => t.id === "solarized-light") as ShippedTheme;
    const vars = { ...block(css, ":root"), ...light.palette, ...block(css, ":root.theme-light") };
    const scene = resolveColour("var(--viewport-bg)", vars);
    const card = over(resolveColour("var(--float-bg)", vars), scene);
    const fills: [string, Rgba][] = [
      ["card", card],
      ["solid card", over(resolveColour("var(--float-bg-solid)", vars), scene)],
      ["tile", over(resolveColour("var(--float-tile-bg)", vars), card)],
      ["chip", over(resolveColour("var(--float-chip-bg)", vars), card)],
      ["field", over(resolveColour("var(--field-bg)", vars), card)],
    ];
    const failing = ["--text", "--text-dim", "--text-mute", "--accent", "--accent-hot"].flatMap((text) =>
      fills
        .map(([fill, bg]) => ({
          text,
          fill,
          ratio: Math.round(contrastRatio(resolveColour(`var(${text})`, vars), bg) * 100) / 100,
        }))
        .filter(({ ratio }) => ratio < 4.5),
    );
    expect(failing).toEqual([]);
    expect(
      contrastRatio(resolveColour("var(--on-accent)", vars), resolveColour("var(--accent)", vars)),
    ).toBeGreaterThan(4.5);
  });

  it("lifts the light theme cards clear of the viewport they float over", () => {
    const css = styleOf(TOKENS, scssFiles.get(TOKENS) ?? "");
    const light = themes().find((t) => t.id === "solarized-light") as ShippedTheme;
    const vars = { ...block(css, ":root"), ...light.palette, ...block(css, ":root.theme-light") };
    const scene = resolveColour("var(--viewport-bg)", vars);
    expect(contrastRatio(over(resolveColour("var(--float-bg)", vars), scene), scene)).toBeGreaterThan(1.15);
  });

  it("toggles settings in Preferences with the checkbox, never a switch", () => {
    const rendered = renderedBy("src/components/overlays/PreferencesDialog.vue", vueFiles);
    expect(rendered).toEqual(
      expect.arrayContaining([
        "src/components/overlays/PluginsSection.vue",
        "src/components/overlays/PluginSettingsForm.vue",
      ]),
    );
    expect(switchesIn(vueFiles, rendered)).toEqual([]);
  });

  it("finds what the check helpers are meant to find", () => {
    expect(
      colourLiterals(
        "x.vue",
        "<template/><style>.a { color: #fff; background: rgba(0,0,0,.5); border-color: white }</style>",
      ),
    ).toBe(3);
    expect(colourLiterals("x.scss", "#viewport .add, #fade { color: var(--text); }")).toBe(0);
    expect(
      flatSurfaces(
        "x.scss",
        ".a { background: var(--panel); } .a:hover { background: var(--raised); } .b { box-shadow: var(--shadow-2); }",
      ),
    ).toEqual([".a", ".b"]);
    expect(
      flatSurfaces("x.scss", ".a { background: var(--glass-sheen), var(--float-bg); color: var(--panel); }"),
    ).toEqual([]);
    expect(
      handBlurs("x.scss", ".a { backdrop-filter: var(--float-blur); } .b { backdrop-filter: blur(8px); }"),
    ).toEqual(["blur(8px)"]);
    expect(outlinedSurfaces([["x.scss", ".chip { border-radius: 8px; border: 1px solid var(--line); }"]])).toHaveLength(
      1,
    );
    expect(
      outlinedSurfaces([
        [
          "x.scss",
          ".chip { border-radius: 8px; border: 1px solid transparent; } .chip:hover { border-color: var(--accent); }",
        ],
      ]),
    ).toEqual(["x.scss .chip:hover { border-color: var(--accent) }"]);
    expect(
      outlinedSurfaces([
        ["x.scss", ".a { corner-shape: squircle; } .x .a.active { box-shadow: inset 0 0 0 1px var(--accent); }"],
      ]),
    ).toHaveLength(1);
    expect(
      outlinedSurfaces([
        [
          "x.scss",
          ".a { border-radius: 8px; } .a:focus-visible { outline: 2px solid var(--accent); } .row { border-top: 1px solid var(--line); }",
        ],
      ]),
    ).toEqual([]);
    const out = (css: string, vue: string[] = []) => outlinedSurfaces([["x.scss", css]], vue);
    const chip = ".chip { border-radius: 8px; }";
    // Rounded by a co-class the template gives the same element.
    expect(
      out(`.btn { border-radius: 8px; } .plug-btn.on { border-color: var(--accent); }`, [
        '<button class="btn plug-btn">x</button>',
      ]),
    ).toHaveLength(1);
    expect(out(`.btn { border-radius: 8px; } .plug-btn.on { border-color: var(--accent); }`)).toEqual([]);
    // Rounded by a parent selector that names only the tag.
    expect(
      out(`.row button { border-radius: 4px; } .done { border: 1px solid var(--accent); }`, [
        '<div class="row"><button class="done">x</button></div>',
      ]),
    ).toHaveLength(1);
    // Ring spellings.
    for (const ring of [
      "0px 0px 0px 1px var(--accent)",
      "0 0 0 .5px var(--accent)",
      "0 0 0 var(--w) var(--accent)",
      "0 0 1px 1px var(--accent)",
      "inset 0 0 0 1px red, 0 1px 3px black",
    ])
      expect(out(`${chip} .chip.on { box-shadow: ${ring}; }`), ring).toHaveLength(1);
    expect(out(`${chip} .chip.on { box-shadow: 0 2px 5px rgba(0,0,0,.3), 0 16px 34px -14px black; }`)).toEqual([]);
    expect(out(`${chip} .chip.on { box-shadow: inset 2px 0 0 var(--accent); }`)).toEqual([]);
    // Other ways to paint an edge.
    for (const decl of [
      "outline-color: var(--accent)",
      "border-style: solid",
      "border-image: linear-gradient(red, blue) 1",
      "border-image-source: linear-gradient(red, blue)",
    ])
      expect(out(`${chip} .chip.on { ${decl}; }`), decl).toHaveLength(1);
    expect(out(`${chip} .chip::after { content: ""; -webkit-mask-composite: xor; }`)).toHaveLength(1);
    expect(out(`${chip} .chip::after { content: ""; mask-composite: exclude; }`)).toHaveLength(1);
    expect(out(`${chip} .chip.on { border-image: none; border: none 0; }`)).toEqual([]);
    // Only a real focus state is exempt.
    expect(out(`${chip} .chip:focus-within { outline: 1px solid red; }`)).toHaveLength(1);
    expect(out(`${chip} .chip:not(:focus) { border-color: red; }`)).toHaveLength(1);
    expect(
      out(`${chip} .chip:focus { outline: 1px solid red; } .chip:focus-visible { outline: 2px solid red; }`),
    ).toEqual([]);
    expect(out(`${chip} .chip:not(:hover):focus-visible { outline: 2px solid red; }`)).toEqual([]);
    expect(contrastRatio(parseColour("#839496"), parseColour("#fffdf8"))).toBeLessThan(4.5);
    const fake = new Map([
      ["a/Prefs.vue", 'import Row from "./b/Row.vue";\n<template><Row /></template>'],
      ["a/b/Row.vue", '<template><span class="param-switch"><input type="checkbox" /></span></template>'],
    ]);
    expect(switchesIn(fake, renderedBy("a/Prefs.vue", fake))).toEqual(["a/b/Row.vue"]);
    const based = new Map([["a/Prefs.vue", '<template><SwitchRow v-model="on" label="Snap" /></template>']]);
    expect(switchesIn(based, ["a/Prefs.vue"])).toEqual(["a/Prefs.vue"]);
    expect(resolveColour("color-mix(in srgb, #ffffff 50%, transparent)", {})).toEqual([255, 255, 255, 0.5]);
    expect(
      untokened(
        "x.scss",
        `.a { color: #fff; background: var(--panel, var(--raised)); transition: color 120ms ease-out;
         border-radius: 8px; .b { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3); } }`,
      ),
    ).toHaveLength(5);
    expect(
      untokened(
        "x.scss",
        `.a { white-space: nowrap; transition: color var(--t-fast) var(--ease); border-radius: 0;
         &:hover { background: var(--hover-wash); } .b { border-radius: var(--float-chip-radius); } }`,
      ),
    ).toEqual([]);
  });
});
