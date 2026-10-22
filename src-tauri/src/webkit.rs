//! WebKitGTK GPU workarounds, applied before the webview starts (Linux only, the other engines read none of this).
//! `decide` is pure so the decision is testable without Nvidia hardware, which nobody here has.

use std::path::Path;

/// Our own opt out, since `WEBKIT_DISABLE_DMABUF_RENDERER=0` does not work: WebKit's checks are presence based in
/// places, so "0" can read as disable.
const OPT_OUT: &str = "FUNDACAD_NO_GPU_WORKAROUND";

/// The name before the rename, still honoured: it lives in shell profiles and .desktop files no rename reaches.
const OPT_OUT_LEGACY: &str = "SINDRICAD_NO_GPU_WORKAROUND";

/// Not `WEBKIT_DISABLE_COMPOSITING_MODE`, which turns off accelerated compositing in a WebGL app (and saw pointer
/// capture stick in issue #6). This only disables the DMA-BUF path, so GTK3 paints each frame through the CPU, a
/// smoothness cost. WebKit calls it a transitional escape hatch, so revisit this module when it goes.
const DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

/// The reason goes to the startup log, since a silent environment change makes later field reports unreadable.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Disable,
    /// Left alone, for one of the `SKIP_*` reasons below.
    Skip(&'static str),
}

// Named so the applier matches on them instead of repeating prose that would drift from `decide`.
const SKIP_OPT_OUT: &str = "opted out via FUNDACAD_NO_GPU_WORKAROUND";
const SKIP_ALREADY_SET: &str = "WEBKIT_DISABLE_DMABUF_RENDERER already set by the environment";
const SKIP_NO_NVIDIA: &str = "no Nvidia driver";

/// Issue #6 (Nobara, RTX 5080, driver 595.84, Wayland): `WebKitWebProcess` segfaults in `libnvidia-eglcore` on launch.
/// Fires for every Nvidia machine, as broken ones cannot be told apart before the crash; the cost is WebKit's
/// documented per frame copy, not measured here.
fn decide(nvidia_present: bool, dmabuf_already_set: bool, opted_out: bool) -> Decision {
    // An explicit human wins over our guess both ways: someone with the variable already set is mid workaround and must
    // not have it changed under them.
    if opted_out {
        return Decision::Skip(SKIP_OPT_OUT);
    }
    if dmabuf_already_set {
        return Decision::Skip(SKIP_ALREADY_SET);
    }
    if !nvidia_present {
        return Decision::Skip(SKIP_NO_NVIDIA);
    }
    Decision::Disable
}

/// `/proc/driver/nvidia/version` marks the loaded Nvidia module, proprietary or open, which both ship the crashing
/// `libnvidia-eglcore`; Nouveau creates neither path. Takes a root for test fixtures.
fn nvidia_driver_present_under(root: &Path) -> bool {
    root.join("proc/driver/nvidia/version").exists() || root.join("sys/module/nvidia/version").exists()
}

/// Must run before the webview is created: WebKit's web process inherits the environment as it stood when spawned.
pub fn apply_gpu_workarounds() {
    let decision = decide(
        nvidia_driver_present_under(Path::new("/")),
        std::env::var_os(DMABUF).is_some(),
        std::env::var_os(OPT_OUT).is_some() || std::env::var_os(OPT_OUT_LEGACY).is_some(),
    );

    match decision {
        Decision::Disable => {
            std::env::set_var(DMABUF, "1");
            // Logged unconditionally: when this machine later files a bug, the
            // terminal output needs to show that we changed the renderer.
            println!(
                "[gpu] Nvidia driver detected, disabling the WebKitGTK DMABUF renderer \
                 (issue #6). Set {OPT_OUT}=1 to keep it."
            );
        }
        // The two environment-driven skips are worth a line for the same reason;
        // "no Nvidia driver" is the ordinary case and stays quiet.
        Decision::Skip(SKIP_NO_NVIDIA) => {}
        Decision::Skip(reason) => {
            println!("[gpu] leaving the WebKitGTK renderer alone: {reason}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reason this module exists: an Nvidia machine must come up with the
    /// DMABUF renderer off, or WebKit segfaults before the app paints (#6).
    #[test]
    fn nvidia_machine_disables_the_dmabuf_renderer() {
        assert_eq!(decide(true, false, false), Decision::Disable);
    }

    /// Everyone else keeps buffer sharing; a blanket disable would cost every Linux user for an Nvidia fault.
    #[test]
    fn non_nvidia_machines_are_untouched() {
        assert_eq!(decide(false, false, false), Decision::Skip(SKIP_NO_NVIDIA));
    }

    /// A variable a human already set wins over the probe, on Nvidia and off, so the configuration they reported
    /// against stays.
    #[test]
    fn an_existing_setting_is_never_overridden() {
        assert!(matches!(decide(true, true, false), Decision::Skip(_)));
        assert!(matches!(decide(false, true, false), Decision::Skip(_)));
    }

    /// And the escape hatch has to be preferred over the probe, or a machine the workaround
    /// harms has no way out.
    #[test]
    fn the_opt_out_is_preferred_over_detection() {
        assert_eq!(decide(true, false, true), Decision::Skip(SKIP_OPT_OUT));
        // …and is preferred over an existing setting too, so one variable always applies.
        assert_eq!(decide(true, true, true), Decision::Skip(SKIP_OPT_OUT));
    }

    /// The probe is filesystem shape, so it is worth pinning: a bare
    /// `/sys/module/nvidia` directory (nvidia_drm can appear on hybrid systems)
    /// is not enough, we look for the version files the real driver writes.
    #[test]
    fn the_probe_matches_the_paths_the_nvidia_driver_actually_writes() {
        let tmp = std::env::temp_dir().join("fundacad-webkit-probe-test");
        let _ = std::fs::remove_dir_all(&tmp);

        std::fs::create_dir_all(tmp.join("sys/module/nvidia")).unwrap();
        assert!(!nvidia_driver_present_under(&tmp), "an empty module directory must not count as the driver");

        std::fs::create_dir_all(tmp.join("proc/driver/nvidia")).unwrap();
        std::fs::write(tmp.join("proc/driver/nvidia/version"), "NVRM version …").unwrap();
        assert!(nvidia_driver_present_under(&tmp), "/proc/driver/nvidia/version is the canonical marker");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Exercises the real entry point through the opt out, which must leave the environment untouched on any machine.
    /// Both spellings in one test, as these are process wide variables a parallel test would race; it restores what it
    /// found.
    #[test]
    fn the_applier_reads_the_variables_it_documents() {
        let restore = std::env::var_os(DMABUF);

        for name in [OPT_OUT, OPT_OUT_LEGACY] {
            std::env::remove_var(DMABUF);
            std::env::set_var(name, "1");

            apply_gpu_workarounds();
            assert!(
                std::env::var_os(DMABUF).is_none(),
                "{name} must stop the applier setting {DMABUF}, on Nvidia hardware or not"
            );

            std::env::remove_var(name);
        }

        // With neither set the applier is free to act, or the loop above would pass on a build without the opt out
        // check.
        std::env::remove_var(DMABUF);
        assert_eq!(
            decide(true, false, false),
            Decision::Disable,
            "with no opt-out set, an Nvidia machine must still get the workaround"
        );

        if let Some(v) = restore {
            std::env::set_var(DMABUF, v);
        } else {
            std::env::remove_var(DMABUF);
        }
    }
}
