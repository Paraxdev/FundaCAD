# Sourced by the AppImage's AppRun before the app starts (added by
# .github/actions/appimage-unbundle). The AppImage uses the system's GTK and
# WebKitGTK instead of bundling them, so on a system without them the app
# would die with a bare loader error. Instead, name what is missing and the
# command that installs it on this distribution, then stop.
#
# Installing it ourselves would need root and cannot work on read-only
# systems, so this only tells the user what to run.

FUNDACAD_RELEASES=https://github.com/Paraxdev/FundaCAD/releases/tag/beta

fundacad_deps_check() {
  local bin="$1" missing
  command -v ldd >/dev/null 2>&1 || return 0
  missing=$(LC_ALL=C ldd "$bin" 2>/dev/null | sed -n 's/^[[:space:]]*\([^[:space:]]*\) => not found.*/\1/p' | sort -u)
  [ -n "$missing" ] || return 0

  local id="" like="" hint
  if [ -r /etc/os-release ]; then
    id=$(. /etc/os-release && echo "${ID:-}")
    like=$(. /etc/os-release && echo "${ID_LIKE:-}")
  fi

  # Where no package can be installed, the Flatpak is the answer: its runtime
  # carries WebKitGTK and GTK, so it needs nothing from the system.
  local flatpak="Use the FundaCAD Flatpak instead, which brings its own WebKitGTK:
  $FUNDACAD_RELEASES
  flatpak install --user ./FundaCAD_<version>_x86_64.flatpak"
  if [ "$id" = nixos ]; then
    hint="NixOS cannot load these libraries from the AppImage.
$flatpak"
  elif [ -e /run/ostree-booted ]; then
    hint="This system is image based.
$flatpak
Or layer the package and reboot: rpm-ostree install webkit2gtk4.1"
  elif [ "$id" = steamos ] || ! fundacad_usr_writable; then
    hint="This system is read-only, so the package cannot be installed on it.
$flatpak"
  else
    # One package per family: WebKitGTK pulls in GTK 3 and libsoup 3 with it.
    case " $id $like " in
      *" debian "*|*" ubuntu "*) hint="sudo apt install libwebkit2gtk-4.1-0" ;;
      *" fedora "*|*" rhel "*)   hint="sudo dnf install webkit2gtk4.1" ;;
      *" arch "*)                hint="sudo pacman -S webkit2gtk-4.1" ;;
      *" suse "*|*" opensuse "*) hint="sudo zypper install libwebkit2gtk-4_1-0" ;;
      *" void "*)                hint="sudo xbps-install libwebkit2gtk41" ;;
      *" gentoo "*)              hint="sudo emerge net-libs/webkit-gtk:4.1" ;;
      *)                         hint="Install WebKitGTK 4.1 (with GTK 3) from your distribution's packages." ;;
    esac
    case "$hint" in sudo*) hint="Install it with:
  $hint" ;; esac
    hint="$hint
Or use the Flatpak, which needs nothing installed: $FUNDACAD_RELEASES"
  fi

  local msg
  msg="FundaCAD needs WebKitGTK 4.1 and GTK 3 from your system, and these libraries are missing:
$(printf '  %s\n' $missing)
$hint"

  printf '%s\n' "$msg" >&2
  # Also show it when started from a launcher, with whatever can draw a window
  # without GTK being complete. Every one of these is optional.
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && [ ! -t 2 ]; then
    kdialog --title FundaCAD --error "$msg" 2>/dev/null \
      || zenity --error --title=FundaCAD --no-wrap --text="$msg" 2>/dev/null \
      || xmessage -center "$msg" 2>/dev/null \
      || notify-send FundaCAD "$msg" 2>/dev/null \
      || true
  fi
  return 1
}

# /usr on a read-only mount (SteamOS and similar) cannot take a package.
fundacad_usr_writable() {
  local opts
  opts=$(findmnt -no OPTIONS -T /usr 2>/dev/null) || return 0
  case ",$opts," in *,ro,*) return 1 ;; esac
  return 0
}

fundacad_deps_check "$this_dir/usr/bin/fundacad" || exit 127
