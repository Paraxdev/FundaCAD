# Install

Pick the file for your system on the [beta page](https://github.com/Paraxdev/fundacad/releases/tag/beta). There is no account, and the builds are not code signed, so each system warns you once.

<!-- shot: install-warning | Windows protect screen with Run anyway -->

**Windows.** Run `FundaCAD-windows-x64-setup.exe`, or the portable `.exe` if you would rather not install. When Windows protects your PC, click More info, then Run anyway.

**macOS.** Open `FundaCAD-macos-arm64.dmg` and drag the app into Applications. If macOS says it is damaged, run this once in Terminal.

```bash
xattr -dr com.apple.quarantine /Applications/FundaCAD.app
```

**Linux.** The Flatpak is the safest choice.

```bash
flatpak install --user ./FundaCAD-linux-x86_64.flatpak
flatpak run dev.fundacad.app
```

On Ubuntu 22.04 or Debian 12 and newer you can use `sudo apt install ./FundaCAD-linux-x86_64.deb` instead.

## Beta or development build

The beta is the one for most people. It is somewhat stable, because a change only reaches it once it has passed every test.

The [development build](https://github.com/Paraxdev/fundacad/releases/tag/development) has every change the day it lands. Take it if you want the newest features and can live with a build that is sometimes broken. The file names are the same on both pages.

A beta install updates itself to the next beta, and a development install to the next development build. To switch, install the file from the other page. If the other build has a lower version number, you may need to uninstall first.
