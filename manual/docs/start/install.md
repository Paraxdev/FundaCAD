# Install

Pick the file for your system on the [beta page](https://github.com/Paraxdev/fundacad/releases/tag/beta). There is no account, and the builds are not code signed, so each system warns you once.

<!-- shot: install-warning | Windows protect screen with Run anyway -->

**Windows.** Run `FundaCAD-windows-x64-setup.exe`, or the portable `.exe` if you would rather not install. When Windows protects your PC, click More info, then Run anyway.

**macOS.** Open `FundaCAD-macos-arm64.dmg` and drag the app into Applications. If macOS says it is damaged, run this once in Terminal.

```bash
xattr -dr com.apple.quarantine /Applications/FundaCAD.app
```

**Linux.** The Flatpak is the safest choice. On Ubuntu, run `sudo apt install flatpak` first. The bundle names Flathub for the GNOME runtime it needs, so Flatpak offers to add it.

```bash
flatpak install --user ./FundaCAD-linux-x86_64.flatpak
flatpak run dev.fundacad.app
```

On Ubuntu 22.04 or Debian 12 and newer you can use `sudo apt install ./FundaCAD-linux-x86_64.deb` instead, and on Fedora `sudo dnf install ./FundaCAD-linux-x86_64.rpm`. The AppImage runs without installing, it needs WebKitGTK 4.1 from your system.

```bash
chmod +x FundaCAD-linux-x86_64.AppImage
./FundaCAD-linux-x86_64.AppImage
```

The Flatpak, the `.deb` and the `.rpm` add FundaCAD to the app menu, and a double click on a `.funda` or `.fundab` file opens it there.

To remove FundaCAD, run `flatpak uninstall dev.fundacad.app`, `sudo apt remove funda-cad` or `sudo dnf remove funda-cad`, or delete the AppImage.

## Beta or development build

The beta is the one for most people. It is somewhat stable, because a change only reaches it once it has passed every test.

The [development build](https://github.com/Paraxdev/fundacad/releases/tag/development) has every change the day it lands. Take it if you want the newest features and can live with a build that is sometimes broken. The file names are the same on both pages.

A beta install updates itself to the next beta, and a development install to the next development build. To switch, install the file from the other page. If the other build has a lower version number, you may need to uninstall first.

On Linux only the AppImage updates itself. The Flatpak, the `.deb` and the `.rpm` stay on the build you installed until you install the newer file over it the same way, with `flatpak install --user --reinstall ./FundaCAD-linux-x86_64.flatpak`, `sudo apt install ./FundaCAD-linux-x86_64.deb` or `sudo dnf install ./FundaCAD-linux-x86_64.rpm`.
