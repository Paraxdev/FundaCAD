import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import ListRow from "../../src/components/ui/ListRow.vue";
import { refOf } from "../../src/ui/controlRefs";

describe("refOf on a ListRow", () => {
  it("names the row opt:<label>, the ref the harness view helper clicks", () => {
    const w = mount(ListRow, { props: { label: "Front" }, attachTo: document.body });
    expect(refOf(w.element as HTMLElement)).toBe("opt:Front");
    w.unmount();
  });
});
