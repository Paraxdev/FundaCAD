# Printed look

Draws the fine layer lines a printed part has across its surface in the Realtime
view. Display only: the model, the file and every export are unchanged.

## Why these grants

`document.read` and nothing else. It writes nothing to the document: what it
draws is a function of its own settings, kept by the app, so there is no write
grant for it to hold.

## What is here

- `look.ts`, the pure half: the settings a person chooses, and the ridges they
  map to (direction to a unit axis, values clamped to what the viewport draws).
- `settings.ts`, the declared settings. Layer lines are off until asked for.
- `LayerLinesSection.vue`, the switch, height, direction and depth rows on the
  Render dock's Environment tab.
- `main.ts`, everything the app is told about it: the relief, the section, the
  Layer lines command and the settings under Preferences.

## Why the ridges are not in the app

The viewport can draw ridges for anyone who contributes them. What a printed
part's layers look like, and which axis they stack along, is this plugin's
business. With it off the app draws exactly what it drew before.
