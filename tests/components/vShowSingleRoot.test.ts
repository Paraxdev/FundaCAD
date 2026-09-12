// v-show on a COMPONENT only works when that component renders one root element.
// With two roots (a panel plus a Teleport beside it, say) Vue cannot pick which
// one to hide, so the directive does nothing at all, with no error in production.
// That is how the Render dock's material list stayed drawn under the Environment
// and Camera tabs. happy-dom would not catch it without mounting every panel's
// whole engine, so this reads the templates instead: every component some other
// template hides with v-show must have exactly one element at its top level.
//
// Sources come from import.meta.glob, as in vHtmlPolicy.test.ts: no @types/node.

import { describe, expect, it } from "vitest";
import { parse } from "@vue/compiler-sfc";
import { NodeTypes, type ElementNode, type RootNode, type TemplateChildNode } from "@vue/compiler-core";

const sources = import.meta.glob("../../src/**/*.vue", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function templateAst(path: string): RootNode | null {
  const { descriptor } = parse(sources[path]!, { filename: path });
  return (descriptor.template?.ast as RootNode | undefined) ?? null;
}

const elements = (children: TemplateChildNode[]) =>
  children.filter((c): c is ElementNode => c.type === NodeTypes.ELEMENT);

/** Resolve "./X.vue" against the glob key of the file importing it. */
function resolveVue(from: string, spec: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** Components used with v-show in a template, with the glob key of each one's file. */
function vShowComponents(path: string): { tag: string; path: string }[] {
  const ast = templateAst(path);
  if (!ast) return [];
  const tags = new Set<string>();
  const walk = (children: TemplateChildNode[]) => {
    for (const c of elements(children)) {
      if (/^[A-Z]/.test(c.tag) && c.props.some((p) => p.type === NodeTypes.DIRECTIVE && p.name === "show")) tags.add(c.tag);
      walk(c.children);
    }
  };
  walk(ast.children);
  return [...tags].map((tag) => {
    const m = sources[path]!.match(new RegExp(`import\\s+${tag}\\s+from\\s+["'](.+?\\.vue)["']`));
    expect(m, `${path} uses <${tag} v-show> but its import was not found`).toBeTruthy();
    return { tag, path: resolveVue(path, m![1]!) };
  });
}

describe("components hidden with v-show", () => {
  const uses = Object.keys(sources).flatMap((f) => vShowComponents(f));

  it("finds the Render dock's tabs, so the check is not vacuous", () => {
    expect(uses.map((u) => u.tag)).toEqual(expect.arrayContaining(["RenderMaterials", "RenderEnvironment", "RenderCamera"]));
  });

  it.each(uses.map((u) => [u.tag, u] as const))("%s renders exactly one root element", (_tag, u) => {
    expect(sources[u.path], `no source for ${u.path}`).toBeDefined();
    expect(elements(templateAst(u.path)?.children ?? []).map((e) => e.tag)).toHaveLength(1);
  });
});
