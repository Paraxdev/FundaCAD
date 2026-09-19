/// Minimum compatible version of OpenCASCADE library (major, minor)
///
/// Pre-installed OpenCASCADE library will be checked for compatibility using semver rules.
const OCCT_VERSION: (u8, u8) = (7, 8);

/// The list of used OpenCASCADE libraries which needs to be linked with.
const OCCT_LIBS: &[&str] = &[
    "TKMath",
    "TKernel",
    "TKDE",
    "TKFeat",
    "TKGeomBase",
    "TKG2d",
    "TKG3d",
    "TKTopAlgo",
    "TKGeomAlgo",
    "TKBRep",
    "TKPrim",
    "TKDESTEP",
    "TKDEIGES",
    "TKDESTL",
    "TKMesh",
    "TKShHealing",
    "TKFillet",
    "TKBool",
    "TKBO",
    "TKOffset",
    "TKXSBase",
    "TKCAF",
    "TKLCAF",
    "TKXCAF",
    // XCAFDoc and XCAFApp pull the OCAF application and presentation layers.
    "TKCDF",
    "TKVCAF",
    "TKV3d",
    "TKService",
    "TKHLR",
];

fn main() {
    let target = std::env::var("TARGET").expect("No TARGET environment variable defined");
    let is_windows = target.to_lowercase().contains("windows");
    let is_windows_gnu = target.to_lowercase().contains("windows-gnu");
    // A MinGW (GCC 16) kernel links once windowscodecs is added, then segfaults
    // inside Extrema_ExtCC during ordinary fillets, so refuse it outright.
    if is_windows_gnu && std::env::var_os("FUNDACAD_ALLOW_WINDOWS_GNU").is_none() {
        panic!(
            r#"

FundaCAD's kernel crashes when built with the MinGW (windows-gnu) toolchain.
A MinGW cargo, such as Chocolatey's, is probably first on PATH. Build with
MSVC instead, for example in PowerShell:

    $env:PATH = "$HOME\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin;$env:PATH"

Set FUNDACAD_ALLOW_WINDOWS_GNU=1 to build it anyway.
"#
        );
    }

    let occt_config = OcctConfig::detect();

    if !occt_config.is_dynamic {
        let patched = patch_occt(&occt_config);
        println!("cargo:rustc-link-search=native={}", patched.display());
    }
    println!("cargo:rustc-link-search=native={}", occt_config.library_dir.to_str().unwrap());

    let lib_type = if occt_config.is_dynamic { "dylib" } else { "static" };
    for lib in OCCT_LIBS {
        println!("cargo:rustc-link-lib={lib_type}={lib}");
    }

    if is_windows {
        println!("cargo:rustc-link-lib=dylib=user32");
        println!("cargo:rustc-link-lib=dylib=advapi32");
    }

    // Every bridge file in src/, so a new bridge needs no edit here. A build
    // script binary shared between checkouts then builds whichever set of
    // bridges the checkout it runs in has.
    let mut rust_bridges: Vec<String> = std::fs::read_dir("src")
        .expect("opencascade-sys src dir")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "rs"))
        .filter(|p| std::fs::read_to_string(p).is_ok_and(|t| t.contains("#[cxx::bridge]")))
        .map(|p| format!("src/{}", p.file_name().unwrap_or_default().to_string_lossy()))
        .collect();
    rust_bridges.sort();

    let mut build = cxx_build::bridges(&rust_bridges);

    if is_windows_gnu {
        build.define("OCC_CONVERT_SIGNALS", "TRUE");
    }

    if let "windows" = std::env::consts::OS {
        let current = std::env::current_dir().unwrap();
        build.include(current.parent().unwrap());
    }

    // MSVC makes every Handle_X a class deriving from opencascade::handle<X>,
    // other compilers a typedef. The bridges bind OCCT methods that take
    // Handle(X) as taking Handle_X, which only type-checks with the typedef,
    // so the shims compile against a copy of Standard_Handle.hxx using it.
    // Handle_X adds no data, OCCT's own signatures use Handle(X).
    if target.contains("msvc") {
        let src = occt_config.include_dir.join("Standard_Handle.hxx");
        let header = std::fs::read_to_string(&src).expect("Standard_Handle.hxx not found");
        let patched = header.replace("#if (defined(_MSC_VER) && _MSC_VER >= 1800)", "#if 0");
        assert!(patched != header, "Standard_Handle.hxx no longer has the MSVC handle class switch");
        let dir = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("occt-override");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Standard_Handle.hxx"), patched).unwrap();
        build.include(dir);
    }

    build
        .cpp(true)
        // The shims use C++14 generic lambdas and later. MSVC defaults to C++14
        // and ignores this flag, so only GCC and Clang ever saw the old c++11.
        .flag_if_supported("-std=c++17")
        .define("_USE_MATH_DEFINES", "TRUE")
        .include(occt_config.include_dir)
        .include("include")
        .compile("rust-occt");

    println!("cargo:rustc-link-lib=static=rust-occt");

    println!("cargo:rerun-if-changed=src");

    // The C++ shim headers are #included by the generated cxx bridges but are not
    // tracked by cxx_build, so edits to them would otherwise not trigger a
    // recompile. Watch the whole include dir.
    println!("cargo:rerun-if-changed=include");
}

/// Our fixes to OCCT sources, each `occt-patch/<file>.cxx` replacing the
/// member of that name in the toolkit library listed here. A copy of the
/// library with the member swapped is searched before the kernel's own, so the
/// link itself does not change and neither does the shared kernel install.
const OCCT_PATCHES: &[(&str, &str)] = &[("ShapeAnalysis_Surface", "TKShHealing")];

fn patch_occt(occt: &OcctConfig) -> std::path::PathBuf {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    println!("cargo:rerun-if-changed=occt-patch");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("occt-patched");
    std::fs::create_dir_all(&out).unwrap();
    let msvc = std::env::var("TARGET").unwrap().contains("msvc");
    let lib_file = |name: &str| if msvc { format!("{name}.lib") } else { format!("lib{name}.a") };

    let mut build = cc::Build::new();
    build
        .cpp(true)
        .opt_level(2)
        .flag_if_supported("-std=c++17")
        .define("_USE_MATH_DEFINES", "TRUE")
        .include(&occt.include_dir);
    let run = |cmd: &mut Command| {
        let got = cmd.output().unwrap_or_else(|e| panic!("could not run {cmd:?}: {e}"));
        assert!(got.status.success(), "{cmd:?} failed: {}", String::from_utf8_lossy(&got.stderr));
        String::from_utf8_lossy(&got.stdout).into_owned()
    };
    for (source, toolkit) in OCCT_PATCHES {
        let objects = build.clone().file(format!("occt-patch/{source}.cxx")).compile_intermediates();
        let original = occt.library_dir.join(lib_file(toolkit));
        let copy = out.join(lib_file(toolkit));
        let members = if msvc {
            run(build.get_archiver().arg("/NOLOGO").arg("/LIST").arg(&original))
        } else {
            run(build.get_archiver().arg("t").arg(&original))
        };
        let wanted = |m: &&str| {
            let file = Path::new(m.trim()).file_name().and_then(|f| f.to_str()).unwrap_or("");
            let file = file.rsplit(['\\', '/']).next().unwrap_or(file);
            file.starts_with(&format!("{source}.")) && (file.ends_with(".obj") || file.ends_with(".o"))
        };
        let member = members
            .lines()
            .find(wanted)
            .unwrap_or_else(|| panic!("{} has no {source} member to replace", original.display()))
            .trim()
            .to_string();
        if msvc {
            run(build
                .get_archiver()
                .arg("/NOLOGO")
                .arg(format!("/OUT:{}", copy.display()))
                .arg(format!("/REMOVE:{member}"))
                .arg(&original)
                .args(&objects));
        } else {
            std::fs::copy(&original, &copy).unwrap();
            run(build.get_archiver().arg("d").arg(&copy).arg(&member));
            run(build.get_archiver().arg("rs").arg(&copy).args(&objects));
        }
    }
    out
}

struct OcctConfig {
    include_dir: std::path::PathBuf,
    library_dir: std::path::PathBuf,
    is_dynamic: bool,
}

impl OcctConfig {
    /// Find OpenCASCADE library using cmake
    fn detect() -> Self {
        println!("cargo:rerun-if-env-changed=DEP_OCCT_ROOT");
        println!("cargo:rerun-if-env-changed=FUNDACAD_OCCT_ROOT");

        // FUNDACAD_OCCT_ROOT points at an installed builtin kernel (cmake,
        // include, lib) so several target dirs share one 22 minute OCCT build.
        let shared_root = std::env::var_os("FUNDACAD_OCCT_ROOT").filter(|v| !v.is_empty());
        if let Some(root) = &shared_root {
            std::env::set_var("DEP_OCCT_ROOT", root);
        }

        #[cfg(feature = "builtin")]
        if shared_root.is_none() {
            occt_sys::build_occt();
            std::env::set_var("DEP_OCCT_ROOT", occt_sys::occt_path().as_os_str());
        }

        let dst =
            std::panic::catch_unwind(|| cmake::Config::new("OCCT").register_dep("occt").build());

        #[cfg(feature = "builtin")]
        let dst = dst.expect("Builtin OpenCASCADE library not found.");

        #[cfg(not(feature = "builtin"))]
        let dst = dst.expect("Pre-installed OpenCASCADE library not found. You can use `builtin` feature if you do not want to install OCCT libraries system-wide.");

        let cfg = std::fs::read_to_string(dst.join("share").join("occ_info.txt"))
            .expect("Something went wrong when detecting OpenCASCADE library.");

        let mut version_major: Option<u8> = None;
        let mut version_minor: Option<u8> = None;
        let mut include_dir: Option<std::path::PathBuf> = None;
        let mut library_dir: Option<std::path::PathBuf> = None;
        let mut is_dynamic: bool = false;

        for line in cfg.lines() {
            if let Some((var, val)) = line.split_once('=') {
                match var {
                    "VERSION_MAJOR" => version_major = val.parse().ok(),
                    "VERSION_MINOR" => version_minor = val.parse().ok(),
                    "INCLUDE_DIR" => include_dir = val.parse().ok(),
                    "LIBRARY_DIR" => library_dir = val.parse().ok(),
                    "BUILD_SHARED_LIBS" => is_dynamic = val == "ON",
                    _ => (),
                }
            }
        }

        if let (Some(version_major), Some(version_minor), Some(include_dir), Some(library_dir)) =
            (version_major, version_minor, include_dir, library_dir)
        {
            if version_major != OCCT_VERSION.0 || version_minor < OCCT_VERSION.1 {
                #[cfg(feature = "builtin")]
                panic!("Builtin OpenCASCADE library found but version is not met (found {}.{} but {}.{} required). Please fix OCCT_VERSION in build script of `opencascade-sys` crate or submodule OCCT in `occt-sys` crate.",
                       version_major, version_minor, OCCT_VERSION.0, OCCT_VERSION.1);

                #[cfg(not(feature = "builtin"))]
                panic!("Pre-installed OpenCASCADE library found but version is not met (found {}.{} but {}.{} required). Please provide required version or use `builtin` feature.",
                       version_major, version_minor, OCCT_VERSION.0, OCCT_VERSION.1);
            }

            Self { include_dir, library_dir, is_dynamic }
        } else {
            panic!("OpenCASCADE library found but something wrong with config.");
        }
    }
}
