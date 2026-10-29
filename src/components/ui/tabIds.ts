// An idref list splits on whitespace, so a value with a space would point at two ids.
const part = (value: string) => value.replace(/\s+/g, "_");

export const tabId = (panels: string, value: string) => `${panels}-tab-${part(value)}`;
export const panelId = (panels: string, value: string) => `${panels}-panel-${part(value)}`;

// For a page whose root is already a layout child (a flex scroller), where a TabPanel wrapper would break the layout.
export const tabPanelAttrs = (panels: string, value: string) => ({
  id: panelId(panels, value),
  role: "tabpanel",
  "aria-labelledby": tabId(panels, value),
});
