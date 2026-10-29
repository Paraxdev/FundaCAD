import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import Icon from "../../../src/components/shell/Icon.vue";

enableAutoUnmount(afterEach);

describe("Icon", () => {
  it("is hidden from screen readers and never a tab stop without a label", () => {
    const w = mount(Icon, { props: { name: "check" } }).get("svg");
    expect([w.attributes("aria-hidden"), w.attributes("focusable"), w.attributes("role")]).toEqual([
      "true",
      "false",
      undefined,
    ]);
  });

  it("reads as an image of its label when it carries meaning alone", () => {
    const w = mount(Icon, { props: { name: "warning", label: "does not hold" } }).get("svg");
    expect([w.attributes("role"), w.attributes("aria-label"), w.attributes("aria-hidden")]).toEqual([
      "img",
      "does not hold",
      undefined,
    ]);
  });
});
