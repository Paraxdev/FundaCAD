# 3D mouse

If you have a 3D mouse, this plugin lets you fly around the model with its puck. It is on by default and adds its items to the View menu.

![The 3D mouse row in Preferences, Plugins, with its settings open](../img/spacemouse-settings.png)

The puck only changes the view, never the model. Pick how it moves in the View menu.

1. SpaceMouse: Object Mode turns the view the way you would turn a part held in your hand. This is the default.
2. SpaceMouse: Camera Mode flies the camera around the part instead.

Button 1 fits the view and button 2 returns to the isometric view.

View, 3D Mouse Settings opens its settings.

1. Mode picks Object mode or Camera mode, as the View menu does.
2. Pan, Zoom and Rotate set the speeds.
3. Deadzone: raise it if the view creeps.
4. Cross-axis filter stops a hard tilt from also zooming.
5. Axis mapping picks which puck motion does what, or inverts it. Live axes shows which bar moves as you push.

## Linux

With `spacenavd` running, FundaCAD reads the mouse through it and needs nothing else. Your `spnavcfg` settings apply here too.

Without it, FundaCAD reads the device itself and needs permission. If it finds the mouse but cannot read it, a message says so. Fix it one of two ways.

1. Start `spacenavd` with `sudo systemctl enable --now spacenavd`.
2. Install the device rule with `sudo sh packaging/setup-spacemouse.sh` from the source folder, then replug the mouse.

The deb and rpm packages install the rule for you.

### Flatpak

The Flatpak reaches the mouse only through `spacenavd`, so start it as in step 1. When FundaCAD runs as a Flatpak, View, 3D Mouse Settings says so too.

To read the device without `spacenavd`, give the Flatpak every device with this command, then restart FundaCAD. It needs the device rule from step 2 as well.

```bash
flatpak override --user --device=all dev.fundacad.app
```

To take that right back, run `flatpak override --user --reset dev.fundacad.app`.
