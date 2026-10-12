# 3D mouse

If you have a 3D mouse, the kind with a puck you push, tilt and twist, this plugin lets you fly around the model with it. It is on by default, and while it is on there is a View menu in the menu bar.

## Two modes

The puck pans, zooms and rotates the view, and the two modes differ in which way that feels. Move Object is the default. It behaves as if you were holding the part in your hand, so the model follows the puck. Move Camera reverses pan and rotation, so the puck flies the camera around the model.

Switch between them in the View menu with SpaceMouse: Move Object and SpaceMouse: Move Camera. A tick shows which one is active. Two buttons on the device have a job as well: button 1 fits the view to the model, and button 2 returns to the isometric view.

## Settings

View, 3D Mouse Settings opens the settings window. It has a live display of the puck's axes, so you can push it and see which bar moves, and a small test cube that turns as you move the puck.

You can change the mode there and set the sensitivity for Pan, Zoom and Rotate. Deadzone is how far the puck has to move before anything happens, and a higher value helps if the view creeps while you are not touching it. Cross-axis filter ignores a weak axis while another is much stronger, so a hard tilt does not also zoom.

Axis mapping lets you choose which movement of the puck drives each action and flip the direction of any of them. Reset to defaults puts everything back.

## If nothing happens

FundaCAD needs permission to read the device. On Linux an installed package brings the rule that grants it, but an AppImage cannot. A 3D mouse driver that is already running can also hold the device. If FundaCAD finds your mouse but cannot read it, it tells you so.
