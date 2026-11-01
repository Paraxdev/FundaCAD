// WebKitGTK and Chromium report a resize that took a second layout pass as a window error, with no Error object.
export const isBrowserNotice = (message: unknown, error: unknown): boolean =>
  error == null && typeof message === "string" && message.includes("ResizeObserver loop");
