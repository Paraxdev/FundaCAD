# Install

Download the file for your system from the [beta page](https://github.com/Paraxdev/fundacad/releases/tag/beta). There is no account to make.

The builds are not code signed, so each system warns you once.

## Windows

1. Run `FundaCAD-windows-x64-setup.exe`.
2. When Windows protects your PC, click More info, then Run anyway.

The portable `FundaCAD-windows-x64-portable.exe` runs without installing. `FundaCAD-windows-x64.msi` installs the same app, for tools that deploy MSI packages.

## macOS

Open `FundaCAD-macos-arm64.dmg` and drag FundaCAD into Applications. If macOS says the app is damaged, run this once in Terminal.

```bash
xattr -dr com.apple.quarantine /Applications/FundaCAD.app
```

## Linux

The Flatpak is the safest choice. On Ubuntu, run `sudo apt install flatpak` first, then Flatpak offers to add Flathub for the runtime it needs.

```bash
flatpak install --user ./FundaCAD-linux-x86_64.flatpak
flatpak run dev.fundacad.app
```

The other files:

1. Ubuntu 22.04, Debian 12 and newer: `sudo apt install ./FundaCAD-linux-x86_64.deb`
2. Fedora: `sudo dnf install ./FundaCAD-linux-x86_64.rpm`
3. Any system with WebKitGTK 4.1: the AppImage runs without installing, after `chmod +x FundaCAD-linux-x86_64.AppImage`.

To remove FundaCAD, run `flatpak uninstall dev.fundacad.app`, `sudo apt remove funda-cad` or `sudo dnf remove funda-cad`, or delete the AppImage.

## Beta or development build

The beta suits most people, a change only reaches it once it has passed every test. The [development build](https://github.com/Paraxdev/fundacad/releases/tag/development) has every change the day it lands, and is sometimes broken.

To switch, install the file from the other page. If its version number is lower, uninstall first.

## Updates

When a new build is out, a message at the bottom of the window says so. Restart & update installs it, after asking you to save your changes.

Preferences > Updates sets when FundaCAD looks:

1. **Check for updates automatically** is on to start with. Off, nothing is sent until you choose Help > Check for Updates….
2. **Check** picks Every launch, Daily or Weekly. Daily is the default.

On Linux only the AppImage updates itself. For the other files, install the newer one over the old one.

## If FundaCAD opens blank

When two starts in a row fail to show the window, the next one is in safe mode. Plugins, saved preferences and work recovery are off, and on Linux so is WebKit compositing, the most common cause of a blank window. Nothing saved is changed.

Click Restart normally on the banner to leave it. To start in safe mode yourself, add `--safe-mode` to the command that starts FundaCAD.

## Where FundaCAD keeps its files

| System | App data | Log |
| --- | --- | --- |
| Windows | `%APPDATA%\dev.fundacad.app` | `%LOCALAPPDATA%\dev.fundacad.app\logs` |
| macOS | `~/Library/Application Support/dev.fundacad.app` | `~/Library/Logs/dev.fundacad.app` |
| Linux | `~/.local/share/dev.fundacad.app` | `~/.local/share/dev.fundacad.app/logs` |
| Flatpak | `~/.var/app/dev.fundacad.app/data/dev.fundacad.app` | the same folder, in `logs` |

The log is `fundacad.log`. [Report a problem](report.md) attaches its end, with user names hidden, unless you untick it.
