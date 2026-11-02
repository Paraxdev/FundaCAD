// A key draw flow that takes no key and holds nothing, for tests that build a SketchMode off its prototype.
export const noKeyDraw = { onKey: () => false, pending: () => false, placed() {}, reset() {} };
