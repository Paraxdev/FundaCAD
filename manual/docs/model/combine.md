# Union, subtract and intersect

Union joins two bodies into one, Subtract removes one from another, and Intersect keeps only where they overlap. They are under Modify on the rail, and the keys are Ctrl+U, Ctrl+B and Ctrl+I.

![A block with a round hole where a cylinder was subtracted](../img/combine-subtract.png)

1. Choose the tool with nothing selected.
2. Click the body to keep.
3. Click the body to use on it. For Subtract, this is the body that cuts and goes away.

With one body selected first, the tool asks only for the second. With two or more selected, it applies at once, keeping the first one selected and using all the others on it.

The step's rows in the History card change it later:

- Operation switches between Union, Subtract and Intersect.
- Keep originals leaves the used bodies in place, so one bolt can cut three plates.
