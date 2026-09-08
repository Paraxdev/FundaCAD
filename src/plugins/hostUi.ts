// The components a plugin may draw with. `fundacad/ui`.
//
// Separate from `fundacad` because that module must stay importable with no
// DOM: a plugin's own logic tests run in a node environment, and one `.vue`
// re-exported from the main host would make every one of them need a DOM to
// parse a file they never render. The split is along "does this drag Vue in",
// which is the same line this repository's own two test projects are drawn on.
//
// Four components, and they earn their place by being the ones that carry
// BEHAVIOUR a plugin should not reimplement: a modal frame that gates global
// shortcuts on mount and releases them on unmount, a floating panel that closes
// on Escape, the icon set the rest of the window is drawn from, and the inline
// rename the browser rows use. A plugin is free to write its own markup for
// anything else, and mostly should.

export { default as FloatingPanel } from "../components/overlays/FloatingPanel.vue";
export { default as Icon } from "../components/shell/Icon.vue";
export { default as InlineLabel } from "../components/shell/InlineLabel.vue";
export { default as ModalFrame } from "../components/overlays/ModalFrame.vue";
