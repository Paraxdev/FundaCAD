// App.vue and mountUi need the whole app, so this reads their sources: the live regions are mounted at boot,
// unconditionally, and the build and mode speech is installed with the UI.

import { describe, expect, it } from "vitest";
import { parse } from "@vue/compiler-sfc";
import { NodeTypes, type ElementNode, type RootNode } from "@vue/compiler-core";

const app = Object.values(
  import.meta.glob("../../src/App.vue", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
)[0]!;
const engine = Object.values(
  import.meta.glob("../../src/app/engine.ts", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >,
)[0]!;

describe("announcer wiring", () => {
  it("App.vue mounts one Announcer at the top of its template, with no condition on it", () => {
    const { descriptor } = parse(app, { filename: "App.vue" });
    const roots = (descriptor.template!.ast as RootNode).children.filter(
      (c): c is ElementNode => c.type === NodeTypes.ELEMENT,
    );
    const announcers = roots.filter((c) => c.tag === "Announcer");
    expect(announcers.map((c) => c.props.filter((p) => p.type === NodeTypes.DIRECTIVE).map((p) => p.name))).toEqual([
      [],
    ]);
    expect(descriptor.scriptSetup!.content).toContain('import Announcer from "./components/ui/Announcer.vue";');
  });

  it("mountUi installs the build, busy and mode announcements", () => {
    const body = /export function mountUi\(e: Engine\): void \{\n([\s\S]*?)\n\}\n/.exec(engine.replace(/\r/g, ""));
    expect(body?.[1]).toMatch(/^\s*installAnnouncements\(e\);$/m);
    expect(engine).toContain('import { installAnnouncements } from "./announcements";');
  });
});
