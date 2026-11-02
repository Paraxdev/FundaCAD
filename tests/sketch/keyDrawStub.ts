// A key draw flow that takes no key and holds nothing, for tests that build a SketchMode off its prototype.
export const noKeyDraw = { onKey: () => false, pending: () => false, placed() {}, reset() {}, pointerPressed() {}, openForNext: () => false, drawn() {}, endSentence: () => null, disarm() {}, armedByKeys() {}, keyPrompt: () => null, pointerMoved() {}, cancelled() {}, settleFocus() {} };

export const noKeySurface = { mount() {}, setStop() {}, focus: () => false, dispose() {} };
