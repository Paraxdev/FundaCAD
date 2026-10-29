// `fundacad/ui`, the components a plugin may draw with. Apart from `fundacad` so that module needs no DOM in a plugin's
// node tests. Each carries behaviour a plugin should not reimplement, like a modal's shortcut gating.

// The base set of src/components/ui, the controls the app draws with (docs/DESIGN.md section 7).
export { default as Button } from "../components/ui/Button.vue";
export { default as Card } from "../components/ui/Card.vue";
export { default as Checkbox } from "../components/ui/Checkbox.vue";
export { default as Chip } from "../components/ui/Chip.vue";
export { default as ConfirmDialog } from "../components/ui/ConfirmDialog.vue";
export { default as Dialog } from "../components/ui/Dialog.vue";
export { default as FieldRow } from "../components/ui/FieldRow.vue";
export { default as IconButton } from "../components/ui/IconButton.vue";
export { default as KeyChip } from "../components/ui/KeyChip.vue";
export { default as ListRow } from "../components/ui/ListRow.vue";
export { default as Menu } from "../components/ui/Menu.vue";
export { default as MenuItem } from "../components/ui/MenuItem.vue";
export { default as MenuSeparator } from "../components/ui/MenuSeparator.vue";
export { default as NumberField } from "../components/ui/NumberField.vue";
export { default as Panel } from "../components/ui/Panel.vue";
export { default as Popover } from "../components/ui/Popover.vue";
export { default as Segmented } from "../components/ui/Segmented.vue";
export { default as Select } from "../components/ui/Select.vue";
export { default as Slider } from "../components/ui/Slider.vue";
export { default as Switch } from "../components/ui/Switch.vue";
export { default as SwitchRow } from "../components/ui/SwitchRow.vue";
export { default as Tabs } from "../components/ui/Tabs.vue";
export { default as TextField } from "../components/ui/TextField.vue";
export { default as UnitChip } from "../components/ui/UnitChip.vue";
export type { SegmentedOption } from "../components/ui/Segmented.vue";
export type { TabItem } from "../components/ui/Tabs.vue";

export { default as Icon } from "../components/shell/Icon.vue";
export { default as InlineLabel } from "../components/shell/InlineLabel.vue";

// The old names of Panel and Dialog, kept for the plugins that import them.
export { default as FloatingPanel } from "../components/overlays/FloatingPanel.vue";
export { default as ModalFrame } from "../components/overlays/ModalFrame.vue";

// The rows the Render dock is made of, so a `renderSections` block matches it.
export { default as RenderChoices } from "../components/shell/RenderChoices.vue";
export { default as RenderSection } from "../components/shell/RenderSection.vue";
export { default as RenderSlider } from "../components/shell/RenderSlider.vue";
export { default as RenderSwitch } from "../components/shell/RenderSwitch.vue";
