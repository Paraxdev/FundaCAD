// Raw UI text outside t(). Parses templates with vue/compiler-sfc and scripts with the TypeScript compiler, so CI
// runs it after npm ci, unlike the dependency free guards. TS is a heuristic: a UI sink, a text property or a sentence.

import ts from "typescript";
import { parse } from "vue/compiler-sfc";

const UI_ATTRS = new Set([
  "title",
  "label",
  "tip",
  "placeholder",
  "aria-label",
  "alt",
  "disabled-reason",
  "disabledReason",
  "hint",
  "heading",
  "description",
  "message",
  "subtitle",
  "empty-text",
  "confirm-label",
  "cancel-label",
  "off-label",
  "on-label",
]);
const UI_PROPS = new Set([
  "label",
  "hint",
  "title",
  "tip",
  "tooltip",
  "message",
  "description",
  "placeholder",
  "prompt",
  "text",
  "ariaLabel",
  "disabledReason",
  "heading",
  "status",
  "caption",
  "summary",
  "detail",
  "subtitle",
  "reason",
  "confirmLabel",
  "cancelLabel",
  "okLabel",
  "body",
]);
const UI_SINKS = new Set([
  "toast",
  "setStatus",
  "setPrompt",
  "confirm",
  "alert",
  "notify",
  "announce",
  "showError",
  "reportError",
  "ask",
  "askConfirm",
  "fail",
  "say",
  "warnUser",
]);
const NOT_TEXT_CALLS =
  /^(console\.|localStorage\.|sessionStorage\.|document\.|.*\.(querySelector|querySelectorAll|closest|addEventListener|removeEventListener|setAttribute|getAttribute|hasAttribute|removeAttribute|setProperty|getPropertyValue|startsWith|endsWith|includes|split|join|replace|match|test|indexOf|emit|has|get|set|add|delete|contains|toggle|remove|matches|createElement)$|invoke$|emit$|readSetting$|createElement$|import$|require$|defineProps$|defineEmits$|defineOptions$|t$)/;
const PRODUCT_WORDS = /\b(?:WebGPU|FundaCAD|STEP|STL|3MF)\b/g;
// Stands for a ${} in a template literal: not a letter, so `${a} ${b}` reads as no text.
const HOLE = "…";

export function isScanned(path) {
  if (!/^(src|plugins)\/.+\.(vue|ts)$/.test(path) || path.endsWith(".d.ts")) return false;
  if (/(^|\/)(node_modules|target|dist)\//.test(path)) return false;
  return !/^src\/(harness|i18n)\//.test(path);
}

const hasText = (s) => (s.replace(PRODUCT_WORDS, "").match(/\p{L}/gu) ?? []).length >= 2;
const looksCode = (raw) => {
  const s = raw.trim().replaceAll(HOLE, "x");
  return (
    /^[a-z][\w-]*$/.test(s) || // an identifier or a key
    /^[\w-]+(\.[\w-]+)+$/.test(s) || // a dotted name or file
    /^[./\\#@]|[{};=<>]|\/\/|\bvar\(|^https?:/.test(s) || // a path, css, markup, url
    /^[A-Z][A-Z0-9_]+$/.test(s) || // a constant
    /^[a-z]+([A-Z][a-z0-9]*)+$/.test(s) // camelCase
  );
};
const sentence = (s) => /^\p{Lu}/u.test(s) && /\s/.test(s) && /\p{Ll}{2}/u.test(s);
const oneLine = (s) => s.trim().replace(/\s+/g, " ");

function literalText(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return node.head.text + node.templateSpans.map((s) => HOLE + s.literal.text).join("");
  return null;
}

function isInert(node) {
  const p = node.parent;
  if (!p) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isLiteralTypeNode(p) || ts.isPropertySignature(p)) return true;
  if (ts.isCaseClause(p) || ts.isElementAccessExpression(p)) return true;
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if (ts.isBinaryExpression(p)) {
    const op = p.operatorToken.kind;
    const K = ts.SyntaxKind;
    return [
      K.EqualsEqualsEqualsToken,
      K.ExclamationEqualsEqualsToken,
      K.EqualsEqualsToken,
      K.ExclamationEqualsToken,
      K.InKeyword,
    ].includes(op);
  }
  return false;
}

function inThrow(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isThrowStatement(p)) return true;
    if (ts.isFunctionLike(p)) return false;
  }
  return false;
}

// The detail a guarded script string reads as, or null. Single capitalised words and thrown messages are not guarded:
// most are ids, saved values like "Box", or errors for the log.
function classifyScript(node, text) {
  if (!hasText(text) || looksCode(text) || isInert(node)) return null;
  let up = node.parent;
  while (up && (ts.isConditionalExpression(up) || ts.isParenthesizedExpression(up) || ts.isBinaryExpression(up)))
    up = up.parent;
  if (up && ts.isCallExpression(up) && up.arguments.some((a) => a === node || a === node.parent)) {
    const name = up.expression.getText();
    if (UI_SINKS.has(name.split(".").pop())) return `${name}()`;
    if (NOT_TEXT_CALLS.test(name)) return null;
  }
  if (up && ts.isPropertyAssignment(up) && ts.isIdentifier(up.name) && UI_PROPS.has(up.name.text))
    return `${up.name.text}:`;
  if (inThrow(node)) return null;
  return sentence(text) ? "sentence" : null;
}

function sourceOf(code, name) {
  return ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;

// Literals and their nesting: a template literal's own holes may hold more strings.
function eachLiteral(sf, visit) {
  const walk = (node) => {
    const text = literalText(node);
    if (text !== null) {
      visit(node, text);
      if (ts.isTemplateExpression(node)) node.templateSpans.forEach((s) => walk(s.expression));
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
}

function scanScript(code, firstLine, add) {
  const sf = sourceOf(code, "s.ts");
  eachLiteral(sf, (node, text) => {
    const detail = classifyScript(node, text);
    if (detail) add(firstLine + lineOf(sf, node), "script", detail, text);
  });
}

// In {{ }} or a bound text attribute a literal that is neither compared nor passed to a helper is shown.
function scanExpression(exp, firstLine, detail, add) {
  const sf = sourceOf(`(${exp});`, "e.ts");
  eachLiteral(sf, (node, text) => {
    if (isInert(node) || ts.isCallExpression(node.parent) || !hasText(text)) return;
    add(firstLine + lineOf(sf, node), "template", detail, text);
  });
}

const TEXT = 2;
const ELEMENT = 1;
const INTERPOLATION = 5;
const ATTRIBUTE = 6;
const DIRECTIVE = 7;

function scanTemplate(nodes, add) {
  for (const node of nodes ?? []) {
    if (node.type === TEXT) {
      if (!hasText(node.content)) continue;
      const lead = node.loc.source.match(/^\s*/)[0].split("\n").length - 1;
      add(node.loc.start.line + lead, "template", "text", node.content);
    } else if (node.type === INTERPOLATION) {
      scanExpression(node.content.content, node.content.loc.start.line, "{{ }}", add);
    } else if (node.type === ELEMENT) {
      for (const prop of node.props) {
        if (prop.type === ATTRIBUTE && prop.value && UI_ATTRS.has(prop.name) && hasText(prop.value.content)) {
          add(prop.loc.start.line, "template", `${prop.name}=`, prop.value.content);
        } else if (prop.type === DIRECTIVE && prop.name === "bind" && prop.exp && UI_ATTRS.has(prop.arg?.content)) {
          scanExpression(prop.exp.content, prop.exp.loc.start.line, `:${prop.arg.content}=`, add);
        }
      }
      scanTemplate(node.children, add);
    }
  }
}

function vueParts(path, src) {
  const { descriptor } = parse(src, { filename: path });
  const scripts = [descriptor.script, descriptor.scriptSetup].filter(Boolean);
  return { template: descriptor.template?.ast?.children ?? [], scripts };
}

export function scanStrings(files) {
  const found = [];
  for (const [path, src] of Object.entries(files)) {
    if (!isScanned(path)) continue;
    const add = (line, kind, detail, text) => found.push({ path, line, kind, detail, text: oneLine(text) });
    if (path.endsWith(".vue")) {
      const { template, scripts } = vueParts(path, src);
      scanTemplate(template, add);
      for (const block of scripts) scanScript(block.content, block.loc.start.line, add);
    } else {
      scanScript(src, 1, add);
    }
  }
  return found.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
}

function collectKeys(code, keys) {
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t") {
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first)) keys.add(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceOf(code, "k.ts"));
}

function templateKeys(nodes, keys) {
  for (const node of nodes ?? []) {
    if (node.type === INTERPOLATION) collectKeys(`(${node.content.content});`, keys);
    if (node.type !== ELEMENT) continue;
    for (const prop of node.props) if (prop.type === DIRECTIVE && prop.exp) collectKeys(`(${prop.exp.content});`, keys);
    templateKeys(node.children, keys);
  }
}

/** Message keys passed to t() as a literal first argument, in scripts and in template expressions. */
export function usedKeys(files) {
  const keys = new Set();
  for (const [path, src] of Object.entries(files)) {
    if (path.endsWith(".vue")) {
      const { template, scripts } = vueParts(path, src);
      templateKeys(template, keys);
      for (const block of scripts) collectKeys(block.content, keys);
    } else if (path.endsWith(".ts")) {
      collectKeys(src, keys);
    }
  }
  return keys;
}

const KINDS = new Set(["template", "script"]);
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
  KINDS.has(e.kind) &&
  Number.isInteger(e.count) &&
  e.count > 0 &&
  typeof e.reason === "string" &&
  e.reason.trim() !== "";

const PLUGIN_PATH = /^plugins\/([^/]+)\//;

/** A plugin's text goes in its own language file, not the core's. */
export function hintFor(path) {
  const id = PLUGIN_PATH.exec(path)?.[1];
  return id ? `add it to plugins/${id}/locales/en.json and show it with the plugin's t()` : "show it with t()";
}

/** A count above its entry is new raw text, one below is a conversion that forgot the list. */
export function checkAllowlist(findings, allow) {
  const problems = [];
  const seen = new Set();
  allow.forEach((e, i) => {
    const label = `entry ${i + 1} (${e?.path} ${e?.kind})`;
    if (!validEntry(e))
      problems.push(`${label}: needs a path, a kind (template or script), a whole count above 0 and a reason`);
    const k = keyOf(e?.path, e?.kind);
    if (seen.has(k)) problems.push(`${label}: listed twice`);
    seen.add(k);
  });
  if (problems.length) return problems;

  const byKey = tally(findings);
  const allowed = new Map(allow.map((e) => [keyOf(e.path, e.kind), e.count]));
  for (const k of [...new Set([...byKey.keys(), ...allowed.keys()])].sort()) {
    const [path, kind] = k.split("\u0000");
    const hits = byKey.get(k) ?? [];
    const max = allowed.get(k) ?? 0;
    const head = `${path}: ${hits.length} raw ${kind} strings, the allowlist allows ${max}`;
    if (hits.length > max) {
      const lines = hits.map((f) => `  ${f.path}:${f.line} ${f.detail} ${JSON.stringify(f.text)}, ${hintFor(f.path)}`);
      problems.push([head, ...lines].join("\n"));
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

/** One entry per line, so lanes that convert different files rarely touch the same line. */
export function formatAllowlist(allow) {
  if (!allow.length) return "[]\n";
  const line = (e) =>
    `  { "path": ${JSON.stringify(e.path)}, "kind": ${JSON.stringify(e.kind)}, "count": ${e.count}, "reason": ${JSON.stringify(e.reason)} }`;
  return `[\n${allow.map(line).join(",\n")}\n]\n`;
}
