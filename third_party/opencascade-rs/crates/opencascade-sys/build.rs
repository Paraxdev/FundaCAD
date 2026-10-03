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
        let original = occt.library_dir.join(static_lib_file(toolkit));
        let copy = out.join(static_lib_file(toolkit));
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

        // FUNDACAD_OCCT_ROOT is where the kernel is installed (cmake, include,
        // lib), so every target dir of a checkout shares one twenty minute
        // OCCT build. The root .cargo/config.toml sets it to <repo>/target/OCCT.
        let shared_root = std::env::var_os("FUNDACAD_OCCT_ROOT")
            .filter(|v| !v.is_empty())
            .map(std::path::PathBuf::from)
            .map(|root| {
                // A relative path would resolve against this crate's directory,
                // not the shell's. The config value is made absolute by cargo.
                if !root.is_absolute() {
                    panic!(
                        "\n\nFUNDACAD_OCCT_ROOT has to be an absolute path, got: {}\n",
                        root.display()
                    );
                }
                let target = std::env::var("TARGET").unwrap();
                if std::env::var("HOST").unwrap() == target {
                    return root;
                }
                // A cross build (cargo --target) needs a kernel of its own.
                let parent = root.parent().map(std::path::Path::to_path_buf).unwrap_or_default();
                parent.join(target).join("OCCT")
            });

        #[cfg(feature = "builtin")]
        let root = {
            let root = shared_root.unwrap_or_else(occt_sys::occt_path);
            build_kernel_into(&root);
            Some(root)
        };
        #[cfg(not(feature = "builtin"))]
        let root = shared_root;

        let config_dir = root.as_deref().and_then(|root| {
            refuse_foreign_kernel(root);
            let lib = root.join("lib");
            if lib.is_dir() {
                println!("cargo:rerun-if-changed={}", lib.display());
            }
            std::env::set_var("DEP_OCCT_ROOT", root);
            kernel_config_dir(root)
        });

        let dst = std::panic::catch_unwind(|| {
            let mut find = cmake::Config::new("OCCT");
            find.register_dep("occt")
                // OCCT's own build registers its build tree in the CMake user
                // package registry, and find_package falls back to the registry
                // when the prefix has no usable config, picking up any stale or
                // half built tree on the machine.
                .define("CMAKE_FIND_USE_PACKAGE_REGISTRY", "OFF")
                .define("CMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY", "OFF")
                .define("CMAKE_FIND_PACKAGE_NO_PACKAGE_REGISTRY", "ON")
                .define("CMAKE_FIND_PACKAGE_NO_SYSTEM_PACKAGE_REGISTRY", "ON");
            if let Some(dir) = &config_dir {
                find.define("OpenCASCADE_DIR", dir);
            }
            find.build()
        });

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

/// Our bookkeeping inside a kernel root: the lock, the fake OUT_DIR handed to
/// occt-sys, the `installing` marker and the `target` stamp. It sits beside
/// `build`, never in it, because cmake-rs wipes `build` when the OCCT sources
/// move.
const STATE_DIR: &str = ".fundacad";

fn static_lib_file(name: &str) -> String {
    if std::env::var("TARGET").unwrap().contains("msvc") {
        format!("{name}.lib")
    } else {
        format!("lib{name}.a")
    }
}

/// The directory holding the installed kernel's OpenCASCADEConfig.cmake, when
/// `root` holds a complete install: `cmake` in OCCT's Windows layout,
/// `lib/cmake/opencascade` in its Unix one.
fn kernel_config_dir(root: &std::path::Path) -> Option<std::path::PathBuf> {
    if root.join(STATE_DIR).join("installing").exists() {
        return None;
    }
    let lib = root.join("lib");
    if !OCCT_LIBS.iter().all(|name| lib.join(static_lib_file(name)).exists()) {
        return None;
    }
    [root.join("cmake"), root.join("lib").join("cmake").join("opencascade")].into_iter().find(
        |dir| {
            dir.join("OpenCASCADEConfig.cmake").exists()
                && dir.join("OpenCASCADEFoundationClassesTargets.cmake").exists()
        },
    )
}

/// Panics when `root` holds a kernel, or a kernel build, for another target or
/// from the other Windows toolchain, which would otherwise fail much later as
/// cmake or linker noise.
fn refuse_foreign_kernel(root: &std::path::Path) {
    let target = std::env::var("TARGET").unwrap();
    let msvc = target.contains("msvc");
    let lib = root.join("lib");
    let (ours, theirs) =
        if msvc { ("TKernel.lib", "libTKernel.a") } else { ("libTKernel.a", "TKernel.lib") };
    let built_by = if msvc { "MinGW or GCC" } else { "MSVC" };

    let stamp = std::fs::read_to_string(root.join(STATE_DIR).join("target")).unwrap_or_default();
    let stamp = stamp.trim();
    let mut evidence = None;
    if !stamp.is_empty() && stamp != target {
        evidence = Some(format!("built for {stamp}"));
    } else if lib.join(theirs).exists() && !lib.join(ours).exists() {
        evidence = Some(format!("built by {built_by} (lib holds {theirs})"));
    } else if target.contains("windows") {
        let cache =
            std::fs::read_to_string(root.join("build").join("CMakeCache.txt")).unwrap_or_default();
        let generator =
            cache.lines().find_map(|l| l.strip_prefix("CMAKE_GENERATOR:INTERNAL=")).unwrap_or("");
        let foreign = if msvc {
            generator.contains("MinGW") || generator.contains("MSYS")
        } else {
            generator.starts_with("Visual Studio")
        };
        if foreign {
            evidence = Some(format!("built by {built_by} (build was configured for {generator})"));
        }
    }
    if let Some(evidence) = evidence {
        panic!(
            r#"

This directory holds an OpenCASCADE kernel {evidence},
which this {target} build cannot use:

    {root}

Delete it and build again. The kernel is then rebuilt there for this build,
which takes about twenty minutes.
"#,
            root = root.display()
        );
    }
}

/// The Visual Studio generator cmake-rs would pick, to be named in its place.
/// Left to pick it itself, cmake-rs hands the build the compiler's own flags
/// as its Release flags with every /O taken out, which compiles the kernel
/// with no optimisation at all. Given a generator it leaves CMake's alone.
#[cfg(feature = "builtin")]
fn msvc_generator() -> Option<&'static str> {
    use cc::windows_registry::{find_vs_version, VsVers};

    if !std::env::var("TARGET").unwrap().contains("msvc")
        || std::env::var_os("CMAKE_GENERATOR").is_some()
    {
        return None;
    }
    match find_vs_version() {
        Ok(VsVers::Vs18) => Some("Visual Studio 18 2026"),
        Ok(VsVers::Vs17) => Some("Visual Studio 17 2022"),
        Ok(VsVers::Vs16) => Some("Visual Studio 16 2019"),
        Ok(VsVers::Vs15) => Some("Visual Studio 15 2017"),
        _ => None,
    }
}

/// A cached Release flags line that carries no optimisation.
#[cfg(feature = "builtin")]
fn unoptimised_flags(line: &str) -> bool {
    ["CMAKE_C_FLAGS_RELEASE:", "CMAKE_CXX_FLAGS_RELEASE:"].iter().any(|var| {
        line.strip_prefix(var).is_some_and(|rest| {
            let flags = rest.split_once('=').map_or("", |(_, value)| value);
            !flags.split_whitespace().any(|f| f.starts_with("/O") || f.starts_with("-O"))
        })
    })
}

/// An MSVC kernel compiled without optimisation, which is rebuilt once.
#[cfg(feature = "builtin")]
fn kernel_unoptimised(root: &std::path::Path) -> bool {
    if !std::env::var("TARGET").unwrap().contains("msvc")
        || root.join(STATE_DIR).join("release-flags").exists()
    {
        return false;
    }
    std::fs::read_to_string(root.join("build").join("CMakeCache.txt"))
        .is_ok_and(|cache| cache.lines().any(unoptimised_flags))
}

/// Builds and installs the kernel into `root` unless a complete one is there.
#[cfg(feature = "builtin")]
fn build_kernel_into(root: &std::path::Path) {
    if kernel_config_dir(root).is_some() && !kernel_unoptimised(root) {
        return;
    }
    refuse_foreign_kernel(root);
    // occt-sys installs into $OUT_DIR/../../../../OCCT and takes no other
    // destination, so it is handed an OUT_DIR four levels below `root`.
    if root.file_name() != Some(std::ffi::OsStr::new("OCCT")) {
        panic!(
            r#"

FUNDACAD_OCCT_ROOT holds no OpenCASCADE install:

    {}

Point it at an installed kernel (with cmake, include and lib in it), or at a
directory named OCCT to build one there.
"#,
            root.display()
        );
    }
    let state = root.join(STATE_DIR);
    let fake_out = state.join("cargo").join("out");
    let build = root.join("build");
    std::fs::create_dir_all(&fake_out).unwrap();
    std::fs::create_dir_all(&build).unwrap();

    // The workspace and src-tauri share one root, and two cargo runs building
    // the kernel into it at once would wreck it. The `installing` marker keeps
    // the unlocked check above from taking a half installed kernel, whether
    // another run is installing it or an earlier one was interrupted.
    let lock = std::fs::File::create(state.join("kernel.lock")).unwrap();
    lock.lock().unwrap();
    if kernel_config_dir(root).is_some() {
        if !kernel_unoptimised(root) {
            return;
        }
        println!(
            "cargo:warning=the OpenCASCADE kernel in {} was compiled without optimisation, rebuilding it once, about twenty minutes",
            root.display()
        );
    }
    let installing = state.join("installing");
    std::fs::write(&installing, "").unwrap();
    let target = std::env::var("TARGET").unwrap();
    std::fs::write(state.join("target"), &target).unwrap();

    // OCCT calls export(PACKAGE) under policy CMP0090 OLD, which writes the
    // build tree into the user package registry unless this is set, and
    // occt-sys passes no defines of ours, so it goes in a seeded cache.
    let cache = build.join("CMakeCache.txt");
    let cached = std::fs::read_to_string(&cache).unwrap_or_default();
    let generator = msvc_generator();
    // Release flags an earlier build cached without optimisation would be
    // kept as they are, so they go and CMake fills in its own. An entry goes
    // with the comment above it, CMake refuses a cache with a comment left over.
    let mut seeded = String::new();
    let mut comment = String::new();
    for line in cached.lines() {
        if line.starts_with("//") {
            comment.push_str(line);
            comment.push('\n');
        } else if generator.is_some() && unoptimised_flags(line) {
            comment.clear();
        } else {
            seeded.push_str(&std::mem::take(&mut comment));
            seeded.push_str(line);
            seeded.push('\n');
        }
    }
    seeded.push_str(&comment);
    if !seeded.contains("CMAKE_EXPORT_NO_PACKAGE_REGISTRY") {
        seeded.push_str("CMAKE_EXPORT_NO_PACKAGE_REGISTRY:BOOL=ON\n");
    }
    if seeded != cached {
        std::fs::write(&cache, seeded).unwrap();
    }

    let out_dir = std::env::var_os("OUT_DIR").unwrap();
    std::env::set_var("OUT_DIR", &fake_out);
    if let Some(generator) = generator {
        std::env::set_var("CMAKE_GENERATOR", generator);
    }
    let built = std::panic::catch_unwind(occt_sys::build_occt);
    if generator.is_some() {
        std::env::remove_var("CMAKE_GENERATOR");
    }
    std::env::set_var("OUT_DIR", out_dir);
    forget_registered_build(&build);
    if let Err(panic) = built {
        std::panic::resume_unwind(panic);
    }

    std::fs::remove_file(&installing).unwrap();
    // Whatever flags this build came out with, it is not rebuilt for them again.
    std::fs::write(state.join("release-flags"), "").unwrap();
    if kernel_config_dir(root).is_none() {
        panic!("OpenCASCADE was built but {} holds no complete install", root.display());
    }
}

/// Removes a CMake user package registry entry for `build`. The seeded cache
/// stops OCCT making one, but cmake-rs deletes the whole build directory, seed
/// included, when the OCCT sources it was configured from have moved.
#[cfg(feature = "builtin")]
fn forget_registered_build(build: &std::path::Path) {
    use std::process::Command;

    let normal = |path: &str| {
        let path = path.trim().trim_start_matches(r"\\?\").replace('\\', "/");
        let path = path.trim_end_matches('/');
        if cfg!(windows) { path.to_lowercase() } else { path.to_string() }
    };
    let build = std::fs::canonicalize(build).unwrap_or_else(|_| build.to_path_buf());
    let build = normal(&build.to_string_lossy());

    if cfg!(windows) {
        let key = r"HKCU\Software\Kitware\CMake\Packages\OpenCASCADE";
        let Ok(listed) = Command::new("reg").args(["query", key]).output() else { return };
        for line in String::from_utf8_lossy(&listed.stdout).lines() {
            if let Some((name, path)) = line.split_once("REG_SZ") {
                if normal(path) == build {
                    let _ = Command::new("reg").args(["delete", key, "/v", name.trim(), "/f"]).output();
                }
            }
        }
    } else if let Some(home) = std::env::var_os("HOME") {
        let packages = std::path::Path::new(&home).join(".cmake/packages/OpenCASCADE");
        for entry in std::fs::read_dir(packages).into_iter().flatten().flatten() {
            if std::fs::read_to_string(entry.path()).is_ok_and(|path| normal(&path) == build) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}
