# Install

Every build is on one page, the [beta release](https://github.com/Paraxdev/fundacad/releases/tag/beta), and you pick the file that matches your system. There is no account and no sign-in.

The beta is a rolling release, so the files on that page are replaced whenever a new build is ready. Once FundaCAD is installed, Help, Check for Updates tells you when there is a newer one.

The builds are not code signed. Each system notices that in its own way and warns you before the first start. The warnings are expected, and the sections below show how to get past them.

## Windows

Download `FundaCAD-windows-x64-setup.exe` for a normal install. If you would rather not install anything, `FundaCAD-windows-x64-portable.exe` runs from wherever you put it. An `.msi` is on the page too.

Windows will probably show a "Windows protected your PC" screen. Click More info, then Run anyway. The portable build shows the same screen the first time it starts.

FundaCAD draws its window with WebView2, which ships with Windows 10 and 11. If you have removed it, Microsoft offers it as a free download.

## macOS

The download is `FundaCAD-macos-arm64.dmg`, built for Apple Silicon Macs. Open it and drag FundaCAD into Applications.

Current macOS versions may tell you the app is damaged. It is not, that is how macOS describes an app without a signature. Run this once in Terminal after moving the app to Applications, and it opens normally from then on.

```bash
xattr -dr com.apple.quarantine /Applications/FundaCAD.app
```

## Linux

Try the Flatpak first, because it brings the libraries it needs with it. It works on NixOS, Fedora Silverblue and SteamOS as well as the usual distributions.

```bash
flatpak install --user ./FundaCAD-linux-x86_64.flatpak
flatpak run dev.fundacad.app
```

On Ubuntu 22.04 or newer, or Debian 12 or newer, the `.deb` also works. Install it with apt and not with `dpkg -i`, because apt fetches whatever the package is missing, while dpkg only reports it and stops.

```bash
sudo apt install ./FundaCAD-linux-x86_64.deb
```

Some distributions only carry an older or a newer WebKitGTK than the `.deb` asks for, and there the package cannot be installed. Use the Flatpak on those. An AppImage and an `.rpm` are on the download page too.

## After the first start

FundaCAD opens with a small welcome window that offers New Document, Open and your recent files. [Your first part](first-part.md) goes from an empty document to a file you can slice.
