import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { defineComponent, ref } from "vue";

import Tabs from "../../../src/components/ui/Tabs.vue";
import TabPanel from "../../../src/components/ui/TabPanel.vue";
import { panelId, tabId } from "../../../src/components/ui/tabIds";

enableAutoUnmount(afterEach);

const Host = defineComponent({
  components: { Tabs, TabPanel },
  setup: () => ({ tab: ref<"views" | "look">("views") }),
  template: `
    <Tabs v-model="tab" label="Views" panels="vc" :tabs="[{ value: 'views', label: 'Views' }, { value: 'look', label: 'Appearance' }]" />
    <TabPanel v-if="tab === 'views'" panels="vc" value="views"><button type="button">Front</button></TabPanel>
    <TabPanel v-else panels="vc" value="look"><button type="button">Shaded</button></TabPanel>`,
});

const byId = (id: string | null | undefined) => (id ? document.getElementById(id) : null);

describe("TabPanel", () => {
  it("is a tabpanel with the panel id, labelled by its tab, and holds its slot", () => {
    const w = mount(TabPanel, { props: { panels: "st", value: "setup" }, slots: { default: "<p>Loads</p>" } });
    expect([w.attributes("role"), w.attributes("id"), w.attributes("aria-labelledby"), w.text()]).toEqual([
      "tabpanel",
      "st-panel-setup",
      "st-tab-setup",
      "Loads",
    ]);
  });

  it("keeps the selected tab's aria-controls and the shown panel's labelledby pointing at each other", async () => {
    const w = mount(Host, { attachTo: document.body });
    const check = () => {
      const tab = document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!;
      const panel = byId(tab.getAttribute("aria-controls"))!;
      return [panel.getAttribute("role"), byId(panel.getAttribute("aria-labelledby")) === tab, panel.textContent];
    };
    expect(check()).toEqual(["tabpanel", true, "Front"]);
    await w.find('[data-tab="look"]').trigger("click");
    await flushPromises();
    expect(check()).toEqual(["tabpanel", true, "Shaded"]);
  });

  it("turns whitespace in a value into an underscore so the idref stays one token", () => {
    expect([tabId("p", "two words"), panelId("p", "two words")]).toEqual(["p-tab-two_words", "p-panel-two_words"]);
  });
});
