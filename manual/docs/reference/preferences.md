# Preferences

Preferences holds the settings that belong to you and not to a particular document: how the app looks, how the view moves, and which plugins are on. Open it from Edit, Preferences, or press Ctrl+,. The categories are listed down the left side. Changes take effect straight away, so there is nothing to save, and Done closes the window.

## Appearance

Theme sets the colours of the whole app. FundaCAD Noir, Dracula, Solarized Light and a few Noir tints come with it. If you want your own, Upload theme loads a small JSON file of colours, with names like `--bg` and `--accent` and values in hex or rgb(). An uploaded theme stays on this computer, and a Remove button appears while it is the active one.

Icons switches between the available icon sets.

Units chooses mm, cm or in for the numbers FundaCAD shows you. It changes the display only. Geometry is always stored in millimetres, so switching units never changes a part.

## Viewport

Reflections picks the room that shiny surfaces reflect. A metal is almost all reflection, so with none it looks nearly black. Flat has no reflections and is the clearest way to read a shape. Background sets the colour behind the model, and Brightness raises or lowers the lights and the reflections together.

Tangent edges decides what happens to the line where two faces meet smoothly, like the border of a fillet. There is no real corner there, only a line across one continuous surface. Show draws it, Faint draws it dimly and Hide removes it.

Bloom adds a glow around the brightest parts of the image. At low settings it only reaches materials that have Glow turned up, so an ordinary part looks the same. Raise it if you want everyday highlights to glow too.

Performance mode makes the view lighter by dropping glass refraction, the high pixel ratio and the extra shadows. Weak graphics cards get it switched on automatically, and you can turn it on yourself if the view stutters or your laptop runs hot. Potato mode goes further, for slow machines and virtual machines. It uses flat shading, half the resolution, and no effects or camera animations.

Several of these are also on the Environment tab of the [Render workspace](../render/materials.md#environment), and they are the same settings.

## Navigation

Smoothing is how long a zoom or a drag takes to catch up with your hand. At 0 the view follows the mouse exactly. Orbit inertia lets a flicked orbit keep turning for a moment after you let go.

Scrolling tells FundaCAD what kind of device you scroll with. Automatic works it out each time you scroll, and you can choose Touchpad or Mouse if it guesses wrong. With a mouse, the wheel zooms. With a touchpad, two fingers turn or move the view and a pinch zooms. Two-finger scroll chooses which of the two it is, orbit or pan, and holding Shift while you scroll does the other one.

Classic camera brings back the camera from before the current navigation was introduced, in case the new one gets in your way. It takes effect after a restart.

## Accessibility

Animations turns every transition off or on. With it off, menus, panels and camera moves jump straight to where they end. It follows your system's reduce motion setting until you change it here.

Hover delay is how long the pointer rests on a part before its face is highlighted in place of the whole part. A click selects whatever is highlighted, so a longer delay makes it easier to select whole parts.

## AI assistants and plugins

AI assistants holds the sharing setting and the setup text for connecting an assistant, which [Connecting an AI assistant](../ai/connect.md) explains.

A plugin that has settings adds its own category after that one, such as Game Controller. The category is there while the plugin is on and gone while it is off. Plugins, the last category, lists the plugins with a switch for each and is where you install or remove them. See [Plugins](../plugins/index.md).
