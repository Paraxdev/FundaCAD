# Extra Parameters

[Parameters](../model/parameters.md) are the named numbers that drive your model, like a wall thickness or a hole diameter. This plugin makes them nicer to live with. It gives a number a slider, sorts parameters into groups, saves whole sets of values as named configurations, and warns you when a value stops making sense.

It is on by default, and it works on top of the parameters you make with Parameters under Modify.

## The Parameters section

Once you have at least one parameter, a Parameters section appears in the Items card. Each of your parameters is listed there with its own control, filed under its group, and changing a value rebuilds the model.

A slider commits when you let go of it. One drag is one undo step and one rebuild, so you can scrub a thickness back and forth without flooding your undo history.

A Configuration picker sits at the top of the section. When one of your checks fails, a warning icon appears in the header and the failing checks are listed with their messages.

## Parameter Setup

Parameter Setup is where you arrange all this. Open it with the small icon in the section header, or from the Edit menu. It has four parts.

Controls decides how each parameter is edited: Number for a plain box, Slider with a minimum, maximum and step, Toggle for an on or off switch, or Choice for a drop-down list. For a choice you type the options as name and value pairs, for example `Small = 10, Large = 30`. You can also put a parameter in a group or hide it from the section.

Groups are named headings for parameters. Type a name and press Enter to add one. Deleting a group does not delete its parameters, they become ungrouped.

Configurations are saved sets of values, and a good way to keep a few sizes of one part in a single document. Set your parameters the way you want, type a name such as "Small" or "Heavy duty", and press Save. Apply sets all the parameters back to those values later, and Update overwrites a configuration with the values you have now.

Checks warn you when a combination does not work. A check is a condition and a message. The condition `gap >= 0.3` with the message "gap below 0.3 mm fuses" warns you as soon as the gap drops under that. Each check is either a Warning or an Error. A control is a way of editing a value and not a rule the model enforces, so if a value must stay within a limit, write a check for it.

Everything here is saved with the document, and Ctrl+Z undoes any change you make in it.

## Optional parts of a model

A toggle becomes useful together with a condition on a step. Right-click a step in the History, choose Add condition, and type into its Active when row. A toggle called `solidCore` and a step whose condition is `solidCore == 1` give you a part with an optional solid core.

## If you switch it off

Turning the plugin off hides the Parameters section and Parameter Setup, and nothing else changes. The document builds the same way, your configurations and checks stay in the file, and switching the plugin back on brings the section back as you left it.
