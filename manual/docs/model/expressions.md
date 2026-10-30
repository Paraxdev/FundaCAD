# Expressions

An expression is a small calculation you type where a number goes, such as `width / 2`. Parameter names work in the value box of a running tool such as Extrude, in a step's values in the History card, on sketch dimensions and in the Parameters dialog.

Type `width / 4` in the value box of Extrude, and the depth stays tied to width, so it follows when width changes. A name that does not exist is refused, and the box says which one.

![A sketch dimension's value box holding hole = width / 5](../img/expression-value.png)

## Writing one

1. Put a name and an equals sign first, as in `hole = width / 5`, to name the result. This works in a tool's value box, in a step's values and on sketch dimensions. The name must be a new one.
2. Units are mm, cm, in, deg and rad, so `1 in` is 25.4 mm.
3. Without a unit, a length is mm and an angle is degrees.
4. Use `+`, `-`, `*`, `/`, `^` for powers, brackets, and `PI`.

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
