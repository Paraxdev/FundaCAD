# Expressions

An expression is a small calculation you type where a number goes, such as `width / 2`. It works in a step's values, in the value box while a tool runs, on sketch dimensions and in the Parameters dialog.

![The Extrude distance box holding rib = width / 4](../img/expression-value.png)

## Writing one

- Put a name and an equals sign first, as in `rib = width / 4`, to name the result.
- Units are mm, cm, in, deg and rad, so `1 in` is 25.4 mm.
- Without a unit, a length is mm and an angle is degrees.
- Use `+`, `-`, `*`, `/`, `^` for powers, brackets, and `PI`.

## Functions

| Kind | Functions |
|---|---|
| Rounding | floor, ceil, round, abs |
| Square root | sqrt |
| Angles, in degrees | sin, cos, tan, asin, acos, atan |
| Choosing | min, max, if |

Separate the values inside the brackets with a semicolon, not a comma, as in `max(2; wall)`.

## Comparisons

`>`, `>=`, `<`, `<=`, `==` and `!=` give 1 when true and 0 when false. Join them with `&&` for and, `||` for or, and `!` for not.

So `if(height > 60; 3; 2)` makes a wall 3 mm on tall parts and 2 mm on short ones.
