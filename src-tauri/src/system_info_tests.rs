use super::*;
use std::fs;
use std::path::PathBuf;

const UBUNTU: &str = "NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\nID=ubuntu\n";
const ARCH: &str = "NAME=Arch Linux\nPRETTY_NAME=Arch Linux\nID=arch\n";

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fundacad-sysinfo-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    dir
}

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

#[test]
fn windows_and_macos_give_os_and_arch_only() {
    assert_eq!(describe("windows", "x86_64", Some(UBUNTU), true, true), "windows x86_64");
    assert_eq!(describe("macos", "aarch64", None, false, false), "macos aarch64");
}

#[test]
fn linux_names_its_distribution_quoted_or_not() {
    let cases = [
        (Some(UBUNTU), "linux x86_64 · Ubuntu 24.04.1 LTS"),
        (Some(ARCH), "linux x86_64 · Arch Linux"),
        (
            Some("PRETTY_NAME='Fedora Linux 41 (Workstation Edition)'\n"),
            "linux x86_64 · Fedora Linux 41 (Workstation Edition)",
        ),
        (Some("  PRETTY_NAME=\"Debian GNU/Linux 12\"  \r\n"), "linux x86_64 · Debian GNU/Linux 12"),
        (Some("NAME=Gentoo\nID=gentoo\n"), "linux x86_64"),
        (Some("PRETTY_NAME=\"\"\n"), "linux x86_64"),
        (Some("garbage without a single key"), "linux x86_64"),
        (None, "linux x86_64"),
    ];
    for (release, want) in cases {
        assert_eq!(describe("linux", "x86_64", release, false, false), want, "{release:?}");
    }
}

#[test]
fn install_kinds_follow_the_distribution_and_a_flatpak_without_one_says_host_unknown() {
    let cases = [
        (Some(UBUNTU), true, false, "linux aarch64 · Ubuntu 24.04.1 LTS · Flatpak"),
        (Some(UBUNTU), false, true, "linux aarch64 · Ubuntu 24.04.1 LTS · AppImage"),
        (Some(ARCH), true, true, "linux aarch64 · Arch Linux · Flatpak · AppImage"),
        (None, true, false, "linux aarch64 · host unknown · Flatpak"),
        (Some("ID=x\n"), true, false, "linux aarch64 · host unknown · Flatpak"),
        (None, false, true, "linux aarch64 · AppImage"),
    ];
    for (release, flatpak, appimage, want) in cases {
        assert_eq!(describe("linux", "aarch64", release, flatpak, appimage), want);
    }
}

#[test]
fn os_release_is_the_hosts_under_a_flatpak_and_etc_otherwise() {
    let both = scratch("both");
    write(&both, "etc/os-release", "PRETTY_NAME=\"GNOME 47 runtime\"\n");
    write(&both, "run/host/os-release", UBUNTU);
    assert_eq!(os_release(&both, true).as_deref(), Some(UBUNTU));
    assert_eq!(os_release(&both, false).as_deref(), Some("PRETTY_NAME=\"GNOME 47 runtime\"\n"));

    let runtime_only = scratch("runtime");
    write(&runtime_only, "etc/os-release", ARCH);
    assert_eq!(os_release(&runtime_only, true), None);
    assert_eq!(os_release(&runtime_only, false).as_deref(), Some(ARCH));

    let empty = scratch("empty");
    fs::create_dir_all(&empty).unwrap();
    assert_eq!((os_release(&empty, true), os_release(&empty, false)), (None, None));
    for dir in [both, runtime_only, empty] {
        fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn each_os_names_its_webview_and_no_version_means_no_line() {
    let cases = [
        ("linux", Some("2.46.3"), Some("WebKitGTK 2.46.3")),
        ("windows", Some("130.0.2849.80"), Some("WebView2 130.0.2849.80")),
        ("macos", Some("19620.1.16.111.4"), Some("WebKit 19620.1.16.111.4")),
        ("linux", None, None),
        ("windows", Some(""), None),
        ("freebsd", Some("2.44.0"), None),
    ];
    for (os, version, want) in cases {
        assert_eq!(webview(os, version).as_deref(), want, "{os} {version:?}");
    }
}
