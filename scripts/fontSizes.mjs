// Font sizes outside the --fs-* tokens (A14). No dependencies, CI runs it before npm ci.

const GLOBAL = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
const FS_REF = /var\(\s*--fs-[a-z]+\s*(?:,[^()]*)?\)/g;
// A --*-scale custom property is a unitless factor by convention, so calc(var(--fs-body) * var(--x-scale)) passes.
const SCALE_REF = /var\(\s*--[a-z0-9-]+-scale\s*\)/g;
const SIZE_WORD =
  /^(?:[\d.]+[a-z%]+|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger|(?:var|calc|min|max|clamp)\(.*\))$/;

export function isScanned(path) {
  if (!/^(src|plugins)\/.+\.(scss|css|vue|ts)$/.test(path)) return false;
  return !/(^|\/)(node_modules|target|dist)\//.test(path);
}

const blank = (s) => s.replace(/[^\r\n]/g, " ");

function cssComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[\s;{}])\/\/[^\r\n]*/g, (m, lead) => lead + blank(m.slice(lead.length)));
}

/** The .vue style blocks kept in place as CSS, everything else as markup and script, both with line breaks intact. */
function regions(path, src) {
  if (/\.(scss|css)$/.test(path)) return { css: cssComments(src), inline: "" };
  if (path.endsWith(".ts")) return { css: "", inline: src };
  let css = blank(src);
  let inline = src.replace(/<!--[\s\S]*?-->/g, blank);
  for (const m of src.matchAll(/(<style\b[^>]*>)([\s\S]*?)<\/style>/g)) {
    const a = m.index + m[1].length;
    const b = a + m[2].length;
    css = css.slice(0, a) + cssComments(m[2]) + css.slice(b);
    inline = inline.slice(0, a) + blank(m[2]) + inline.slice(b);
  }
  return { css, inline };
}

function topLevelTokens(value) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && (/\s/.test(ch) || ch === "/" || ch === ",")) {
      if (cur) out.push(cur);
      if (ch === "/" || ch === ",") out.push(ch);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** The size inside a font shorthand: the token before the line height slash, or else the first size like token. */
export function shorthandSize(value) {
  const tokens = topLevelTokens(value.trim());
  const slash = tokens.indexOf("/");
  if (slash > 0) return tokens[slash - 1];
  for (const t of tokens) {
    if (t === ",") break;
    if (SIZE_WORD.test(t)) return t;
  }
  return null;
}

/** True for a size that comes from the tokens: a --fs-* var, maybe scaled, or a global keyword. */
export function isTokened(size) {
  const s = size.replace(/!important$/, "").trim();
  if (GLOBAL.has(s)) return true;
  if (!s.match(FS_REF)) return false;
  const rest = s
    .replace(FS_REF, "")
    .replace(SCALE_REF, "")
    .replace(/\b(?:calc|min|max|clamp)\(/g, "(");
  return /^[\s()*+\-/.\d,]*$/.test(rest);
}

function lineAt(src, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

const CSS_DECL = /(?<![\w.#-])(font-size|font)\s*:\s*([^;{}]+)/g;
const QUOTED_DECL = /(?<![\w-])(fontSize|font-size|font)\s*:\s*(["'`])([^"'`\r\n]*)\2/g;
const STYLE_DECL = /(?<![\w.#-])(font-size|font)\s*:\s*([^;{}"'`\r\n]+)/g;

function check(prop, value) {
  const v = value.trim();
  if (!v) return null;
  if (prop === "font") {
    if (GLOBAL.has(v)) return null;
    const size = shorthandSize(v);
    if (size === null || isTokened(size)) return null;
  } else if (isTokened(v)) return null;
  return `${prop}: ${v.replace(/\s+/g, " ")}`;
}

export function scanFontSizes(files) {
  const findings = [];
  for (const [path, src] of Object.entries(files)) {
    if (!isScanned(path)) continue;
    const { css, inline } = regions(path, src);
    const hit = (text, index, prop, value) => {
      const decl = check(prop, value);
      if (decl) findings.push({ path, line: lineAt(text, index), decl });
    };
    for (const m of css.matchAll(CSS_DECL)) hit(css, m.index, m[1], m[2]);
    for (const m of inline.matchAll(QUOTED_DECL)) hit(inline, m.index, m[1], m[3]);
    for (const m of inline.matchAll(STYLE_DECL)) hit(inline, m.index, m[1], m[2]);
  }
  return findings.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
}

function tally(findings) {
  const byPath = new Map();
  for (const f of findings) {
    if (!byPath.has(f.path)) byPath.set(f.path, []);
    byPath.get(f.path).push(f);
  }
  return byPath;
}

const validEntry = (e) =>
  !!e &&
  typeof e.path === "string" &&
  e.path !== "" &&
  Number.isInteger(e.count) &&
  e.count > 0 &&
  typeof e.reason === "string" &&
  e.reason.trim() !== "";

/** A count above its entry is a new raw size, one below is a move to tokens that forgot the list. */
export function checkAllowlist(findings, allow) {
  const problems = [];
  const seen = new Set();
  allow.forEach((e, i) => {
    const label = `entry ${i + 1} (${e?.path})`;
    if (!validEntry(e)) problems.push(`${label}: needs a path, a whole count above 0 and a reason`);
    if (seen.has(e?.path)) problems.push(`${label}: listed twice`);
    seen.add(e?.path);
  });
  if (problems.length) return problems;

  const byPath = tally(findings);
  const allowed = new Map(allow.map((e) => [e.path, e.count]));
  for (const path of [...new Set([...byPath.keys(), ...allowed.keys()])].sort()) {
    const hits = byPath.get(path) ?? [];
    const max = allowed.get(path) ?? 0;
    const head = `${path}: ${hits.length} font sizes outside the tokens, the allowlist allows ${max}`;
    if (hits.length > max) {
      problems.push([head, ...hits.map((f) => `  ${f.path}:${f.line} ${f.decl}, use a var(--fs-*) token`)].join("\n"));
    } else if (hits.length < max) {
      problems.push(hits.length ? `${head}, lower its count to ${hits.length}` : `${head}, remove the entry`);
    }
  }
  return problems;
}

/** The allowlist with every count lowered to what is found and spent entries dropped. It never raises a count. */
export function lowerAllowlist(findings, allow) {
  const byPath = tally(findings);
  return allow
    .map((e) => ({ ...e, count: Math.min(e.count, byPath.get(e.path)?.length ?? 0) }))
    .filter((e) => e.count > 0);
}

export function formatAllowlist(allow) {
  if (!allow.length) return "[]\n";
  const line = (e) =>
    `  { "path": ${JSON.stringify(e.path)}, "count": ${e.count}, "reason": ${JSON.stringify(e.reason)} }`;
  return `[\n${allow.map(line).join(",\n")}\n]\n`;
}
