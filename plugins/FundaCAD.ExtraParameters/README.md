# Extra Parameters

Sliders, toggles and choices for parameters, groups to file them in, named
configurations of a design, and checks that warn when values stop making sense.

## Why these grants

`document.read` and `document.write`, and nothing else. A control, a group, a
configuration and a check are all stored in the document, and applying a
configuration writes parameter values.

## What is here

- `ParametersSection.vue`, the Parameters section of the browser: a
  configuration picker, the checks that do not hold, and each user parameter
  through its control, in its group. A slider commits when it is let go, so one
  drag is one undo step and one rebuild.
- `SetupPanel.vue`, Edit, Parameter Setup: which control a parameter gets and
  its range or choices, the groups, the configurations and the checks.
- `view.ts`, what both panels show, worked out without a DOM so the node suite
  can test it.
- `main.ts`, everything the app is told about all of it.

## What stays in the app

The data. `ParamDef.control`, `group` and `hidden`, and the document's
`paramExtras` (groups, configurations, checks), are the file format, and every
one of them names parameters. The params engine renames through all of them and
refuses to delete a parameter a check or a configuration value reads. If this
plugin owned that data, a parameter renamed while it was switched off would
leave a configuration setting a name that no longer exists.

The evaluation is in the app too (`src/params/extras.ts`): what a value clamps
to, which checks fail, what applying a configuration would do. The store's
`applyConfiguration` and this plugin's panels call the same functions, so the
panel cannot promise a configuration the store then refuses.

So turning this off hides the section and the setup panel and changes nothing
about how the document builds. A control is a way of editing a value, never a
constraint the build enforces.

## Conditions

A feature's Active when row (right-click a history step, Add condition) is the
app's own, because whether a feature builds is part of the file. The pairing
this plugin is for: a toggle parameter `solidCore`, and a feature whose Active
when is `solidCore == 1`.
