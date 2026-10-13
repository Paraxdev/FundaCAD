# Reading the stress result

When a run finishes, the part is coloured from lowest stress to highest, and Edit setup reopens the inputs.

![The Stress panel listing peak stress, deflection and safety factor beside the coloured bracket](../img/stress-results.png)

The results give the peak stress, the largest deflection and the safety factor, which is the yield strength divided by the peak stress. Below 1 the panel flags it. A printed part is weaker across layer lines, so do not trust a number barely over 1.

The Deformation slider exaggerates the bend, and Probe reads the stress at a point. The study is linear and approximate, so use it to compare designs and not to predict when a part breaks.
