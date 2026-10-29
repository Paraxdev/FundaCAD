// App.vue needs the whole app to mount, so this reads its source, as announcerWiring.test.ts does.

import { describe, expect, it } from "vitest";
import { parse } from "@vue/compiler-sfc";
import {
  NodeTypes,
  type AttributeNode,
  type ElementNode,
  type RootNode,
  type TemplateChildNode,
} from "@vue/compiler-core";

const app = Object.values(
  import.meta.glob("../../src/App.vue", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
)[0]!;

const elements = (nodes: TemplateChildNode[]) => nodes.filter((c): c is ElementNode => c.type === NodeTypes.ELEMENT);
const attr = (el: ElementNode, name: string) =>
  el.props.find((p): p is AttributeNode => p.type === NodeTypes.ATTRIBUTE && p.name === name)?.value?.content;
const roots = () => elements((parse(app, { filename: "App.vue" }).descriptor.template!.ast as RootNode).children);

describe("landmark wiring", () => {
  it("puts the skip link first after the announcer, before the title bar", () => {
    expect(
      roots()
        .slice(0, 3)
        .map((c) => c.tag),
    ).toEqual(["Announcer", "SkipLink", "TitleBar"]);
  });

  it("wraps the stage in one main landmark named Model", () => {
    const mains = roots().filter((c) => c.tag === "main");
    expect(mains.map((m) => [attr(m, "id"), attr(m, "aria-label")])).toEqual([["main", "Model"]]);
    expect(roots().some((c) => attr(c, "id") === "main" && c.tag !== "main")).toBe(false);
  });

  it("opens the Model landmark with an sr-only h1 holding the document name", () => {
    const main = roots().find((c) => c.tag === "main")!;
    const [first] = elements(main.children);
    expect(first?.tag).toBe("h1");
    expect(attr(first!, "class")).toBe("sr-only");
    const text = first!.children.find((c) => c.type === NodeTypes.INTERPOLATION);
    expect(text && "content" in text && "content" in text.content ? text.content.content.trim() : "").toBe(
      "ui.docName",
    );
  });
});
