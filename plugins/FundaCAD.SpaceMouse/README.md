# 3D mouse

Navigates the view with a 3D mouse. It never edits the document.

## Why these grants

`device.input` for the puck. Object mode only flips the direction of the view
navigation (`modeSign` in `spacemouse.ts`), so nothing here asks to write to the
document.

## What is here

- `spacemouse.ts`, the axis filter, the bindings and the stored settings.
- `SpaceMouseModal.vue`, the settings window, with the live axis bars and the
  test cube.
- `SettingsHost.vue`, mounts that window only while it is open, because a
  contributed overlay is mounted for the whole life of the capability and this
  one builds a WebGL scene.
- `state.ts`, whether the window is open. A ref here rather than a field on the
  app's dialog store, which had no business holding one piece of state per
  capability that might want a window.
- `main.ts`, the device, and the View menu.

The app contained none of this before only in the sense that it did not import
it. It still wrote out every row of the View menu behind a capability check,
mounted the settings window itself, carried `dialogs.spaceMouse`, and kept a
cached handle on the input module so it could answer "which mode is ticked"
synchronously. That last one is gone for a reason worth noting: a menu's
`checked` is a thunk the menubar calls when the menu opens, so the mode can be
read straight from the module, by code that is allowed to import it.
