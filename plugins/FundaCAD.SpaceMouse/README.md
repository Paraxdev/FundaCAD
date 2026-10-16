# 3D mouse

Navigates the view with a 3D mouse. It never edits the document.

## Why these grants

`device.input` for the puck. Object mode only flips the direction of the view
navigation (`modeSign` in `spacemouse.ts`), so nothing here asks to write to the
document.

## What is here

- `spacemouse.ts`, the axis filter, the bindings, and the declared settings
  (mode, sensitivities as a share of the default, deadzone, cross-axis filter),
  which the app draws under this plugin's row in Preferences > Plugins.
- `SpaceMouseSection.vue`, drawn below those settings: the live axis bars, the
  test cube and the axis mapping. Loaded async and mounted only while the row
  is expanded, because it builds a WebGL scene.
- `main.ts`, the device, and the View menu, whose "3D Mouse Settings" opens
  the row.

The app contained none of this before only in the sense that it did not import
it. It still wrote out every row of the View menu behind a capability check,
mounted the settings window itself, carried `dialogs.spaceMouse`, and kept a
cached handle on the input module so it could answer "which mode is ticked"
synchronously. That last one is gone for a reason worth noting: a menu's
`checked` is a thunk the menubar calls when the menu opens, so the mode can be
read straight from the module, by code that is allowed to import it.
