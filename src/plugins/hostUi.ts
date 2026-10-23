// `fundacad/ui`, the components a plugin may draw with. Apart from `fundacad` so that module needs no DOM in a plugin's
// node tests. Each carries behaviour a plugin should not reimplement, like a modal's shortcut gating.

export { default as FloatingPanel } from "../components/overlays/FloatingPanel.vue";
export { default as Icon } from "../components/shell/Icon.vue";
export { default as InlineLabel } from "../components/shell/InlineLabel.vue";
export { default as ModalFrame } from "../components/overlays/ModalFrame.vue";

// The rows the Render dock is made of, so a `renderSections` block matches it.
export { default as RenderChoices } from "../components/shell/RenderChoices.vue";
export { default as RenderSection } from "../components/shell/RenderSection.vue";
export { default as RenderSlider } from "../components/shell/RenderSlider.vue";
export { default as RenderSwitch } from "../components/shell/RenderSwitch.vue";
