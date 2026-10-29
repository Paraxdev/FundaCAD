// An idref list splits on whitespace, so a value with a space would point at two ids.
const part = (value: string) => value.replace(/\s+/g, "_");

export const tabId = (panels: string, value: string) => `${panels}-tab-${part(value)}`;
export const panelId = (panels: string, value: string) => `${panels}-panel-${part(value)}`;
