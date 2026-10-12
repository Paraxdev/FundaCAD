# Parameters

A parameter is a number with a name. Instead of typing 40 into the width of a box, a plate and a lid, you make a parameter called `width` and use it in all three places. Change it once and everything that uses it follows.

For printing, this keeps a design adjustable. Wall thickness, screw size and the gap between a lid and a box are the kind of values you end up changing after the first test print.

## The Parameters dialog

Open Modify on the rail and pick Parameters. The dialog has two lists.

<!-- shot: parameters-dialog | the Parameters dialog with a few user parameters and one model parameter -->

User Parameters are the ones you make yourself. To add one, fill in the bottom row with a name, an expression and a unit, then press + Add. The unit is mm for lengths, deg for angles, or unitless for plain numbers such as a count. You can rename a parameter, change its expression or write a comment at any time. A parameter that something still uses cannot be deleted, and the dialog names what is using it.

Model Parameters, named d1, d2 and so on, appear on their own. FundaCAD makes one whenever you put an expression into a value, and the last column says which step and which field it drives. They disappear along with the value they belong to.

## Using a parameter

Any value box accepts a parameter name or an expression where it would take a number. That includes the value rows of a step in the History and the dimensions in a sketch. Type `width` and press Enter, and the value is tied to the parameter. Type `width / 2` and it is tied to half of it.

An expression you type is stored under an automatic name like d3. Put a name and an equals sign in front, as in `rib = width / 4`, and that name is used, which is easier to recognise in the dialog later.

A value that holds an expression is labelled `fx:` before the number. Dragging a handle does not overwrite it, because the expression would only overwrite the drag. Change the parameter or the expression.

## What expressions can do

Expressions are written in millimetres and degrees. You may add a unit to a number, and the suffixes are mm, cm, in, deg and rad, so `1 in` means 25.4 mm. A number without a unit means mm for a length and degrees for an angle, whatever unit the document displays.

The usual arithmetic works, with ^ for powers and brackets to group. PI is a constant, and the functions are sin, cos, tan, asin, acos, atan, floor, ceil, round, abs, sqrt, min, max and if. The trig functions work in degrees, so `sin(30)` is 0.5.

Comparisons such as `>`, `<=` and `==` give 1 when true and 0 when false, and `&&` and `||` join them. Together with `if(condition, a, b)` that lets one value depend on another. Give a parameter called `wall` the expression `if(height > 60, 3, 2)`, and the wall is 3 mm for tall parts and 2 mm for short ones.

A parameter cannot be named after a function, a unit or PI. If an expression uses a name that does not exist, or two parameters depend on each other in a circle, the dialog marks the row and keeps the old value.

## Switching steps on and off

A step in the History can be given a condition. Right-click the step, choose Add condition, and type an expression into its Active when row. The step runs while the expression is not zero and is skipped otherwise.

Say you want the same box with and without a lid. Make a parameter `withLid` set to 1 or 0, and give the lid steps the condition `withLid == 1`.

## Sliders, groups and configurations

A plain parameter is a number you type. The [Extra Parameters](../plugins/extra-parameters.md) plugin, which is on by default, gives a parameter a slider, a switch or a drop-down, and shows those controls in the Items card. It also sorts parameters into groups, saves whole sets of values as named configurations, and warns you when a value breaks a rule you wrote.
