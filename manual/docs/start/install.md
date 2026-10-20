# Install

Pick the file for your system on the [stable release page](https://github.com/Paraxdev/fundacad/releases/latest). There is no account, and the builds are not code signed, so each system warns you once.

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

## Stable or beta

The stable release is the one to use for real work. The [beta](https://github.com/Paraxdev/fundacad/releases/tag/beta) is the preview: it is rebuilt every time something changes, so you get new features first, and sometimes a bug that the stable release does not have. The file names are the same on both pages.

When a stable install updates itself, it moves to the next stable release, and a beta install to the next beta. To switch, install the file from the other page. Going from stable back to the beta can need an uninstall first, because the beta's version number is lower.
