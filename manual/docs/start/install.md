# Install

Download the file for your system from the [beta page](https://github.com/Paraxdev/fundacad/releases/tag/beta). There is no account to make.

The builds are not code signed, so each system warns you once.

<!-- shot: install-warning | Windows protect screen with Run anyway -->

## Windows

1. Run `FundaCAD-windows-x64-setup.exe`. The portable `FundaCAD-windows-x64-portable.exe` runs without installing.
2. When Windows protects your PC, click More info, then Run anyway.

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

- Ubuntu 22.04, Debian 12 and newer: `sudo apt install ./FundaCAD-linux-x86_64.deb`
- Fedora: `sudo dnf install ./FundaCAD-linux-x86_64.rpm`
- Any system with WebKitGTK 4.1: the AppImage runs without installing, after `chmod +x FundaCAD-linux-x86_64.AppImage`.

The Flatpak, the `.deb` and the `.rpm` add FundaCAD to the app menu, and a double click on a `.funda` or `.fundab` file opens it.

To remove FundaCAD, run `flatpak uninstall dev.fundacad.app`, `sudo apt remove funda-cad` or `sudo dnf remove funda-cad`, or delete the AppImage.

## Beta or development build

The beta suits most people. A change only reaches it once it has passed every test.

The [development build](https://github.com/Paraxdev/fundacad/releases/tag/development) has every change the day it lands, and is sometimes broken. The file names are the same on both pages.

To switch, install the file from the other page. If the other build has a lower version number, you may need to uninstall first.

## Updates

A beta install updates to the next beta, and a development install to the next development build. When one is out, a message at the bottom of the window says so.

Restart & update on that message installs it. It asks you to save unsaved changes first, and to finish an open sketch.

Preferences > Updates sets when FundaCAD looks:

- **Check for updates automatically** is on to start with. Off, nothing is sent until you choose Help > Check for Updates….
- **Check** picks Every launch, Daily or Weekly. Daily is the default.

On Linux only the AppImage updates itself. For the Flatpak, the `.deb` or the `.rpm`, install the newer file over the old one, with `flatpak install --user --reinstall ./FundaCAD-linux-x86_64.flatpak` for the Flatpak.

## If FundaCAD opens blank

When two starts in a row do not get as far as showing the window, the next start is in safe mode. A banner at the top says why.

- Plugins, your saved preferences and work recovery are off for that session.
- On Linux, WebKit compositing is off too, the most common cause of a blank window.
- Nothing saved is changed, and preferences you change in safe mode are forgotten when it closes.

Click Restart normally to leave it.

To ask for safe mode yourself, start FundaCAD with `--safe-mode` (`flatpak run dev.fundacad.app --safe-mode` for the Flatpak) or with `FUNDACAD_SAFE_MODE=1` set. Take the switch out of your launcher or shell profile afterwards, or the next start is safe again.

A settings file that cannot be read is renamed to `<name>.bad-<time>` in the app data folder, and the app starts without it. Attach that file when you report the problem.

## Where FundaCAD keeps its files

| System | App data | Log |
| --- | --- | --- |
| Windows | `%APPDATA%\dev.fundacad.app` | `%LOCALAPPDATA%\dev.fundacad.app\logs` |
| macOS | `~/Library/Application Support/dev.fundacad.app` | `~/Library/Logs/dev.fundacad.app` |
| Linux | `~/.local/share/dev.fundacad.app` | `~/.local/share/dev.fundacad.app/logs` |
| Flatpak | `~/.var/app/dev.fundacad.app/data/dev.fundacad.app` | the same folder, in `logs` |

The log is `fundacad.log`, and each start is added to its end. Past 4 MB it moves to `fundacad.1.log`, so the folder holds three logs at most.

[Report a problem](report.md) attaches the end of the log, with user names hidden, unless you untick it. Started from a terminal, FundaCAD logs to the terminal instead, and a report from that run carries no log.
