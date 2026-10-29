// The raw control scan behind scripts/check-ui-controls.mjs and tests/ui/uiControls.test.ts. Pure, so the script feeds
// it from fs and the test from import.meta.glob. Scanned with regexes and a small lexer, not parsed: no deps.

const CONTROL_TAGS = ["button", "input", "select", "textarea"];
const CONTROL_ROLES = new Set(["button", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "radio"]);
const STYLE_BAD = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(|\bborder|\bfont\s*:|\bfont-family\b|\bfontFamily\b/;
const LEGACY_CLASSES = [
  [/^btn(-|$)/, "btn"],
  [/^sm-input$/, "sm-input"],
  [/^pref-seg$/, "pref-seg"],
  [/^ft-switch$/, "ft-switch"],
  [/^param-switch$/, "param-switch"],
  [/^check$/, "check"],
];
const DOM_FACTORIES =
  "the factories in src/components/ui/dom.ts (uiButton, uiIconButton, uiNumberInput, uiSwitch, ...)";

const USE_INSTEAD = {
  button: "Button, or IconButton for an icon only button",
  "input[type=checkbox]": "Checkbox, or Switch for an on and off setting",
  "input[type=radio]": "Segmented",
  "input[type=range]": "Slider",
  "input[type=number]": "NumberField",
  "input[type=text]": "TextField, or NumberField for a value",
  "input[type=search]": "TextField",
  "input[type=url]": "TextField",
  "input[type=file]": "pickFile in src/components/ui/dom.ts",
  "input[type=color]": "no base component yet, keep it on the allowlist with a reason",
  input: "TextField or NumberField",
  select: "Select",
  textarea: "TextField",
  "role=button": "Button",
  "role=switch": "Switch",
  "role=tab": "Tabs",
  "role=menuitem": "MenuItem",
  "role=menuitemcheckbox": "MenuItem",
  "role=menuitemradio": "MenuItem",
  "role=radio": "Segmented",
  "style:inline": "a class in src/styles that reads tokens only",
  "IconButton:no-name": "IconButton with tip (and keys), which writes title and aria-label",
  "RailButton:no-name": "RailButton with label, which is its accessible name",
  "Segmented:no-name": "a label or tip on every icon only Segmented option",
  "class:btn": "Button",
  "class:sm-input": "TextField or NumberField",
  "class:pref-seg": "Segmented",
  "class:ft-switch": "Switch",
  "class:param-switch": "Switch",
  "class:check": "Checkbox",
};

export function useInstead(kind) {
  if (kind.startsWith("createElement:") || kind.startsWith("html:")) return DOM_FACTORIES;
  return USE_INSTEAD[kind] ?? "a base component from src/components/ui";
}

export function isScanned(path) {
  if (!/^(src|plugins)\/.+\.(vue|ts)$/.test(path)) return false;
  if (/(^|\/)(node_modules|target|dist)\//.test(path)) return false;
  return !path.startsWith("src/components/ui/");
}

const blank = (s) => s.replace(/[^\r\n]/g, " ");

function keepOnly(src, ranges) {
  let out = "";
  let at = 0;
  for (const [a, b] of ranges) {
    out += blank(src.slice(at, a)) + src.slice(a, b);
    at = b;
  }
  return out + blank(src.slice(at));
}

function vueRegions(src) {
  const scripts = [];
  for (const m of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    const start = m.index + m[0].indexOf(">") + 1;
    scripts.push([start, start + m[1].length]);
  }
  const open = /^<template\b[^>]*>/m.exec(src);
  const closes = [...src.matchAll(/^<\/template>/gm)];
  const close = closes[closes.length - 1];
  let template = "";
  if (open && close && close.index > open.index) {
    template = keepOnly(src, [[open.index + open[0].length, close.index]]).replace(/<!--[\s\S]*?-->/g, blank);
  } else {
    template = blank(src);
  }
  return { template, script: keepOnly(src, scripts) };
}

const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
]);

// Comments and regex literals come back blanked, and inString marks the text of every string literal.
function lexScript(src) {
  const n = src.length;
  const out = src.split("");
  const inString = new Uint8Array(n);
  const wipe = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  const holes = [];
  let depth = 0;
  let prev = "";

  const template = (from) => {
    let j = from;
    while (j < n) {
      if (src[j] === "\\") j += 2;
      else if (src[j] === "`") {
        inString.fill(1, from, j);
        return j + 1;
      } else if (src[j] === "$" && src[j + 1] === "{") {
        inString.fill(1, from, j);
        holes.push(depth);
        depth++;
        return j + 2;
      } else j++;
    }
    inString.fill(1, from, n);
    return n;
  };

  let i = 0;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? n : e;
      wipe(i, end);
      i = end;
    } else if (c === "/" && next === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      wipe(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      inString.fill(1, i + 1, j);
      i = j + 1;
      prev = "a";
    } else if (c === "`") {
      i = template(i + 1);
      prev = "a";
    } else if (c === "/" && (prev === "" || REGEX_AFTER_WORD.has(prev) || "(,=:[!&|?{};+-*%<>~^".includes(prev))) {
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
        else if (src[j] === "/" && !cls) break;
        j++;
      }
      if (src[j] !== "/") {
        prev = c;
        i++;
        continue;
      }
      j++;
      while (j < n && /\w/.test(src[j])) j++;
      wipe(i, j);
      i = j;
      prev = "a";
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) j++;
      prev = src.slice(i, j);
      i = j;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (holes.length && holes[holes.length - 1] === depth) {
          holes.pop();
          i = template(i + 1);
          prev = "a";
          continue;
        }
      }
      prev = /\d/.test(c) ? "a" : c;
      i++;
    }
  }
  return { code: out.join(""), inString };
}

function readAttrs(text, from) {
  let j = from;
  let quote = "";
  for (; j < text.length; j++) {
    const ch = text[j];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") break;
  }
  const attrs = new Map();
  const body = text.slice(from, j);
  for (const m of body.matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attrs.set(m[1], m[2] ?? m[3] ?? m[4] ?? true);
  }
  return attrs;
}

function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return (at) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// A name a screen reader can read: one of `props` or aria-label/aria-labelledby, static and not blank, or bound to
// anything but an empty literal, null, undefined or false. A v-bind spread may carry one, so it counts.
function hasName(attrs, props) {
  if (attrs.has("v-bind")) return true;
  for (const p of [...props, "aria-label", "aria-labelledby"]) {
    const plain = attrs.get(p);
    if (typeof plain === "string" && plain.trim() !== "") return true;
    const bound = attrs.get(`:${p}`) ?? attrs.get(`v-bind:${p}`);
    if (typeof bound === "string" && !/^\s*(?:(["'`])\s*\1|null|undefined|false)?\s*$/.test(bound)) return true;
  }
  return false;
}

// Tag to [kind, the props that name it]. RailButton's tip is only its title, so its label has to be there.
const ICON_CONTROLS = {
  IconButton: ["IconButton:no-name", ["tip"]],
  "icon-button": ["IconButton:no-name", ["tip"]],
  RailButton: ["RailButton:no-name", ["label"]],
  "rail-button": ["RailButton:no-name", ["label"]],
};

function scanTemplate(text, hit, legacyClasses, options) {
  for (const m of text.matchAll(/<([A-Za-z][\w-]*)(?=[\s>/])/g)) {
    const name = m[1];
    const isControl = CONTROL_TAGS.includes(name);
    const icon = ICON_CONTROLS[name];
    const isSegmented = name === "Segmented" || name === "ui-segmented";
    const isPlain = /^[a-z][a-z0-9]*$/.test(name);
    if (!isControl && !icon && !isSegmented && !isPlain) continue;
    const attrs = readAttrs(text, m.index + m[0].length);
    if (isControl && name === "input") {
      const type = attrs.get("type");
      const bound = attrs.has(":type") || attrs.has("v-bind:type");
      hit(m.index, bound ? "input" : `input[type=${typeof type === "string" ? type : "text"}]`);
    } else if (isControl) {
      hit(m.index, name);
    } else if (icon) {
      if (!hasName(attrs, icon[1])) hit(m.index, icon[0]);
    } else if (isSegmented) {
      for (let k = namelessSegments(attrs, options); k > 0; k--) hit(m.index, "Segmented:no-name");
    } else {
      const role = attrs.get("role");
      if (typeof role === "string" && CONTROL_ROLES.has(role)) hit(m.index, `role=${role}`);
    }
  }
  for (const m of text.matchAll(/(?<=\s)(?::|v-bind:)?style\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (STYLE_BAD.test(m[1] ?? m[2] ?? "")) hit(m.index, "style:inline");
  }
  if (!legacyClasses) return;
  for (const m of text.matchAll(/(?<=\s)class\s*=\s*"([^"]*)"/g)) {
    for (const token of m[1].split(/\s+/)) {
      const legacy = LEGACY_CLASSES.find(([re]) => re.test(token));
      if (legacy) hit(m.index, `class:${legacy[1]}`);
    }
  }
}

function balanced(code, open) {
  let depth = 0;
  for (let j = open; j < code.length; j++) {
    if (code[j] === "{") depth++;
    else if (code[j] === "}" && --depth === 0) return code.slice(open, j + 1);
  }
  return code.slice(open);
}

function scanScript(text, hit) {
  const { code, inString } = lexScript(text);
  for (const m of code.matchAll(/\bcreateElement\(\s*(["'`])(button|input|select|textarea)\1/g)) {
    hit(m.index, `createElement:${m[2]}`);
  }
  for (const m of code.matchAll(/<(button|input|select|textarea)(?=[\s>/])/g)) {
    if (inString[m.index]) hit(m.index, `html:${m[1]}`);
  }
  for (const m of code.matchAll(/\bCSSProperties\b/g)) {
    const lead = /^[\s>)=(]*\{/.exec(code.slice(m.index + m[0].length));
    if (!lead) continue;
    const object = balanced(code, m.index + m[0].length + lead[0].length - 1);
    if (STYLE_BAD.test(object)) hit(m.index, "style:inline");
  }
}

// Where `id` is declared in lexed `code`: the initializer of a const, let or var up to its `;`, or a function's body.
function declaration(lexed, id) {
  const { code, inString } = lexed;
  const re = new RegExp(String.raw`\b(?:(?:const|let|var)\s+${id}\b[^=;]*=|function\s+${id}\s*\()`, "g");
  for (const m of code.matchAll(re)) {
    if (inString[m.index]) continue;
    const fn = m[0].startsWith("function");
    let depth = fn ? 1 : 0;
    for (let j = m.index + m[0].length; j < code.length; j++) {
      if (inString[j]) continue;
      const ch = code[j];
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) {
        if (--depth === 0 && fn && ch === "}") return [m.index, j + 1];
      } else if (ch === ";" && depth === 0 && !fn) return [m.index, j];
    }
    return [m.index, code.length];
  }
  return null;
}

// The top level keys of each object literal in [from, to) that has a `value` key, so is a Segmented option.
function optionKeys(lexed, from, to) {
  const { code, inString } = lexed;
  const out = [];
  for (let i = from; i < to; i++) {
    if (code[i] !== "{" || inString[i]) continue;
    const keys = new Set();
    let depth = 0;
    let part = "";
    let j = i + 1;
    const take = () => {
      const k = /^\s*(\.\.\.|(["']?)([\w$-]+)\2\s*(?::|\(|$))/.exec(part);
      if (k) keys.add(k[1] === "..." ? "..." : k[3]);
      part = "";
    };
    for (; j < to; j++) {
      const ch = code[j];
      if (!inString[j] && depth === 0 && (ch === "," || ch === "}")) {
        take();
        if (ch === "}") break;
        continue;
      }
      if (!inString[j] && "([{".includes(ch)) depth++;
      else if (!inString[j] && ")]}".includes(ch)) depth--;
      part += ch;
    }
    if (keys.has("value")) out.push({ keys, text: code.slice(i, j) });
  }
  return out;
}

// How many options of one Segmented show only an icon with nothing to name them, over both branches of a ternary.
// An options expression this cannot follow to its declaration in the file, or to an export of another scanned file,
// is not counted.
function namelessSegments(attrs, sources) {
  const expr = attrs.get(":options") ?? attrs.get("v-bind:options");
  if (typeof expr !== "string") return 0;
  const iconOnly = ["icon-only", "iconOnly", ":icon-only", ":iconOnly"].some(
    (a) => attrs.has(a) && attrs.get(a) !== "false",
  );
  const branches = /^[^?:]+\?\s*([\w$.()\s]+?)\s*:\s*([\w$.()\s]+?)\s*$/.exec(expr);
  const exprs = branches ? [branches[1], branches[2]] : [expr];
  return exprs.reduce((n, e) => n + namelessOptions(e, iconOnly, sources), 0);
}

function namelessOptions(expr, iconOnly, { script, exported }) {
  const id = /^\s*([A-Za-z_$][\w$]*)\s*(?:\(\s*\)|\.value)?\s*$/.exec(expr)?.[1];
  let lexed = id ? script : lexScript(expr);
  let span = id ? declaration(script, id) : [0, expr.length];
  if (id && !span) {
    lexed = exported(id);
    span = lexed && declaration(lexed, id);
  }
  if (!span) return 0;
  return optionKeys(lexed, span[0], span[1]).filter(({ keys, text }) => {
    if (keys.has("...") || keys.has("label") || keys.has("tip") || /aria-label/.test(text)) return false;
    return iconOnly || keys.has("icon");
  }).length;
}

/** Every raw control in `files` (path to source, paths relative to the repo root with forward slashes). */
export function scanControls(files, { legacyClasses = false } = {}) {
  const found = [];
  const lexedTs = new Map();
  const exported = (id) => {
    const re = new RegExp(String.raw`\bexport\s+(?:const|let|function)\s+${id}\b`);
    for (const [path, src] of Object.entries(files)) {
      if (!path.endsWith(".ts") || !re.test(src)) continue;
      if (!lexedTs.has(path)) lexedTs.set(path, lexScript(src));
      return lexedTs.get(path);
    }
    return null;
  };
  for (const [path, src] of Object.entries(files)) {
    if (!isScanned(path)) continue;
    const lineAt = lineIndex(src);
    const hit = (at, kind) => found.push({ path, line: lineAt(at), kind, at });
    if (path.endsWith(".vue")) {
      const { template, script } = vueRegions(src);
      scanTemplate(template, hit, legacyClasses, { script: lexScript(script), exported });
      scanScript(script, hit);
    } else {
      scanScript(src, hit);
    }
  }
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.at - b.at));
  return found.map(({ path, line, kind }) => ({ path, line, kind }));
}

const keyOf = (path, kind) => `${path}\u0000${kind}`;

function tally(findings) {
  const byKey = new Map();
  for (const f of findings) {
    const k = keyOf(f.path, f.kind);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(f);
  }
  return byKey;
}

const validEntry = (e) =>
  !!e &&
  typeof e.path === "string" &&
  e.path !== "" &&
  typeof e.kind === "string" &&
  e.kind !== "" &&
  Number.isInteger(e.count) &&
  e.count > 0 &&
  typeof e.reason === "string" &&
  e.reason.trim() !== "";

/** What breaks the ratchet: a count above its entry is a new raw control, one below is a migration that forgot the list. */
export function checkAllowlist(findings, allow) {
  const problems = [];
  const seen = new Set();
  allow.forEach((e, i) => {
    const label = `entry ${i + 1} (${e?.path} ${e?.kind})`;
    if (!validEntry(e)) problems.push(`${label}: needs a path, a kind, a whole count above 0 and a reason`);
    const k = keyOf(e?.path, e?.kind);
    if (seen.has(k)) problems.push(`${label}: listed twice`);
    seen.add(k);
  });
  if (problems.length) return problems;

  const byKey = tally(findings);
  const allowed = new Map(allow.map((e) => [keyOf(e.path, e.kind), e.count]));
  const keys = [...new Set([...byKey.keys(), ...allowed.keys()])].sort();
  for (const k of keys) {
    const [path, kind] = k.split("\u0000");
    const hits = byKey.get(k) ?? [];
    const max = allowed.get(k) ?? 0;
    const head = `${path}: ${hits.length} ${kind}, the allowlist allows ${max}`;
    if (hits.length > max) {
      problems.push(
        [head, ...hits.map((f) => `  ${f.path}:${f.line} ${f.kind}, use ${useInstead(f.kind)}`)].join("\n"),
      );
    } else if (hits.length < max) {
      problems.push(hits.length ? `${head}, lower its count to ${hits.length}` : `${head}, remove the entry`);
    }
  }
  return problems;
}

/** The allowlist with every count lowered to what is found and spent entries dropped. It never raises a count. */
export function lowerAllowlist(findings, allow) {
  const byKey = tally(findings);
  return allow
    .map((e) => ({ ...e, count: Math.min(e.count, byKey.get(keyOf(e.path, e.kind))?.length ?? 0) }))
    .filter((e) => e.count > 0);
}

/** One entry per line, so lanes that lower different files rarely touch the same line. */
export function formatAllowlist(allow) {
  if (!allow.length) return "[]\n";
  const line = (e) =>
    `  { "path": ${JSON.stringify(e.path)}, "kind": ${JSON.stringify(e.kind)}, "count": ${e.count}, "reason": ${JSON.stringify(e.reason)} }`;
  return `[\n${allow.map(line).join(",\n")}\n]\n`;
}
