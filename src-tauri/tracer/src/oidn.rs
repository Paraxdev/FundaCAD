//! Open Image Denoise, never bundled: the CPU file set of the official release
//! is unpacked into a folder of the app's data, and loaded from there only
//! once every file matched its pinned SHA-256.

use std::ffi::{c_char, c_void, CStr, CString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use sha2::{Digest, Sha256};

use crate::denoise::{Input, Quality};

pub const VERSION: &str = "2.5.1";

/// One file of the CPU set: where it sits in the archive below its top
/// folder, where it is installed, and its digest.
#[derive(Clone, Copy, Debug)]
pub struct Pinned {
    pub member: &'static str,
    pub file: &'static str,
    pub sha256: &'static str,
}

/// An official release archive. `files` are loaded in order, the API library
/// last, so each one's imports are already in the process.
#[derive(Clone, Copy, Debug)]
pub struct Release {
    pub url: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
    /// The size of the CPU set once installed.
    pub installed: u64,
    pub zip: bool,
    pub files: &'static [Pinned],
}

const WINDOWS: Release = Release {
    url: "https://github.com/RenderKit/oidn/releases/download/v2.5.1/oidn-2.5.1.x64.windows.zip",
    sha256: "f11f91bc072a5e3a564515724cb72ab8fcfbc445c84a84c197ff9b16cc01396f",
    bytes: 56_619_412,
    installed: 51_840_672,
    zip: true,
    files: &[
        Pinned { member: "bin/tbb12.dll", file: "bin/tbb12.dll", sha256: "454ea95817cd33b837540bbfe21f6bf415f6fbf2ad712c2353896d17492e763d" },
        Pinned {
            member: "bin/OpenImageDenoise_core.dll",
            file: "bin/OpenImageDenoise_core.dll",
            sha256: "18557e4424297ed892f2a0285dd565ec9065234a84bac1b84d16fd995371a422",
        },
        Pinned {
            member: "bin/OpenImageDenoise_device_cpu.dll",
            file: "bin/OpenImageDenoise_device_cpu.dll",
            sha256: "e22617f115ae4056c3417983545aebed1d75ac7c1baca086c39d18a84bf47d78",
        },
        Pinned {
            member: "bin/OpenImageDenoise.dll",
            file: "bin/OpenImageDenoise.dll",
            sha256: "64ceb78b1e10342a5323ead6f346d7f2b2e1c69fe17c399bebbcef3df26bed16",
        },
    ],
};

// device_cpu needs libtbb.so.12 by that name and every library has the RPATH
// $ORIGIN/../lib, so the set goes into lib/ with tbb under its soname.
const LINUX: Release = Release {
    url: "https://github.com/RenderKit/oidn/releases/download/v2.5.1/oidn-2.5.1.x86_64.linux.tar.gz",
    sha256: "743c3e2aff8c220d5d70fe6cb970fb3d36f2702d2693c61d1d148e404cf37cd6",
    bytes: 66_613_458,
    installed: 55_941_192,
    zip: false,
    files: &[
        Pinned { member: "lib/libtbb.so.12.19", file: "lib/libtbb.so.12", sha256: "2c1fcbc65a33771a5e02a201734774252528e10f57cef9e2f902fe209c0319e1" },
        Pinned {
            member: "lib/libOpenImageDenoise_core.so.2.5.1",
            file: "lib/libOpenImageDenoise_core.so.2.5.1",
            sha256: "34282521f0456c67e1005a1b2c29b65845223af354f173c0e7993c545cab033e",
        },
        Pinned {
            member: "lib/libOpenImageDenoise_device_cpu.so.2.5.1",
            file: "lib/libOpenImageDenoise_device_cpu.so.2.5.1",
            sha256: "9d43cabeaba31afe9d571c449625d76cf35b72398b7138204c41a688fbb50d11",
        },
        Pinned {
            member: "lib/libOpenImageDenoise.so.2.5.1",
            file: "lib/libOpenImageDenoise.so.2.5.1",
            sha256: "8f8b88740eb4bec96c0d0aa84ad54758b3732ed4529ee77af7892e7df618ef79",
        },
    ],
};

/// The release for this platform, or why there is none to download.
pub fn release() -> Result<&'static Release, String> {
    if cfg!(target_os = "macos") {
        return Err("the high quality denoise is not offered on macOS yet, the edge aware filter cleans the picture".into());
    }
    if cfg!(all(windows, target_arch = "x86_64")) {
        return Ok(&WINDOWS);
    }
    if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        return Ok(&LINUX);
    }
    Err("there is no Open Image Denoise build for this platform".into())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Every file is there and matches its digest.
pub fn verify(dir: &Path, files: &[Pinned]) -> Result<(), String> {
    for f in files {
        let path = dir.join(f.file);
        let bytes = std::fs::read(&path).map_err(|e| format!("{} is missing ({e})", f.file))?;
        if sha256_hex(&bytes) != f.sha256 {
            return Err(format!("{} does not match its pinned digest", f.file));
        }
    }
    Ok(())
}

type Device = *mut c_void;
type Filter = *mut c_void;

const DEVICE_CPU: i32 = 1;
const FORMAT_FLOAT3: i32 = 3;
const QUALITY_BALANCED: i32 = 5;
const QUALITY_HIGH: i32 = 6;

/// The part of the C API the denoise calls, resolved from the loaded set.
pub struct Api {
    _libs: Vec<libloading::Library>,
    new_device: unsafe extern "C" fn(i32) -> Device,
    commit_device: unsafe extern "C" fn(Device),
    device_error: unsafe extern "C" fn(Device, *mut *const c_char) -> i32,
    release_device: unsafe extern "C" fn(Device),
    new_filter: unsafe extern "C" fn(Device, *const c_char) -> Filter,
    set_image: unsafe extern "C" fn(Filter, *const c_char, *mut c_void, i32, usize, usize, usize, usize, usize),
    set_bool: unsafe extern "C" fn(Filter, *const c_char, bool),
    set_int: unsafe extern "C" fn(Filter, *const c_char, i32),
    commit_filter: unsafe extern "C" fn(Filter),
    execute_filter: unsafe extern "C" fn(Filter),
    release_filter: unsafe extern "C" fn(Filter),
}

fn open_lib(path: &Path) -> Result<libloading::Library, String> {
    #[cfg(windows)]
    let lib = unsafe {
        use libloading::os::windows::{Library, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR};
        Library::load_with_flags(path, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS).map(Into::into)
    };
    #[cfg(not(windows))]
    let lib = unsafe { libloading::Library::new(path) };
    lib.map_err(|e| format!("{} did not load ({e})", path.display()))
}

impl Api {
    /// Checks the set, loads it and makes one CPU device to prove it runs.
    pub fn open(dir: &Path, files: &[Pinned]) -> Result<Api, String> {
        verify(dir, files)?;
        let mut libs = Vec::new();
        for f in files {
            libs.push(open_lib(&dir.join(f.file))?);
        }
        let lib = libs.last().ok_or("an empty file set")?;
        macro_rules! sym {
            ($name:literal) => {
                *unsafe { lib.get($name) }.map_err(|e| format!("{} is missing from the library ({e})", String::from_utf8_lossy(&$name[..$name.len() - 1])))?
            };
        }
        let api = Api {
            new_device: sym!(b"oidnNewDevice\0"),
            commit_device: sym!(b"oidnCommitDevice\0"),
            device_error: sym!(b"oidnGetDeviceError\0"),
            release_device: sym!(b"oidnReleaseDevice\0"),
            new_filter: sym!(b"oidnNewFilter\0"),
            set_image: sym!(b"oidnSetSharedFilterImage\0"),
            set_bool: sym!(b"oidnSetFilterBool\0"),
            set_int: sym!(b"oidnSetFilterInt\0"),
            commit_filter: sym!(b"oidnCommitFilter\0"),
            execute_filter: sym!(b"oidnExecuteFilter\0"),
            release_filter: sym!(b"oidnReleaseFilter\0"),
            _libs: libs,
        };
        let d = api.device()?;
        unsafe { (api.release_device)(d) };
        Ok(api)
    }

    fn error(&self, d: Device) -> Result<(), String> {
        let mut msg: *const c_char = std::ptr::null();
        let code = unsafe { (self.device_error)(d, &mut msg) };
        if code == 0 {
            return Ok(());
        }
        let text = if msg.is_null() { String::new() } else { unsafe { CStr::from_ptr(msg) }.to_string_lossy().into_owned() };
        Err(format!("Open Image Denoise error {code}: {text}"))
    }

    fn device(&self) -> Result<Device, String> {
        let d = unsafe { (self.new_device)(DEVICE_CPU) };
        if d.is_null() {
            return Err("Open Image Denoise made no CPU device".into());
        }
        unsafe { (self.commit_device)(d) };
        if let Err(e) = self.error(d) {
            unsafe { (self.release_device)(d) };
            return Err(e);
        }
        Ok(d)
    }

    /// The ray tracing filter on linear HDR colour with clean albedo and
    /// normal guides, as the `oidn` crate was driven before.
    pub fn denoise(&self, input: &Input, quality: Quality) -> Result<Vec<f32>, String> {
        let n = input.width * input.height * 3;
        if input.color.len() != n || input.albedo.len() != n || input.normal.len() != n {
            return Err("the denoise buffers do not match the frame".into());
        }
        let mut color = input.color.clone();
        let mut albedo = input.albedo.clone();
        let mut normal = input.normal.clone();
        let mut out = vec![0.0f32; n];
        let d = self.device()?;
        let c = |s: &str| CString::new(s).unwrap();
        let r = unsafe {
            let f = (self.new_filter)(d, c("RT").as_ptr());
            let r = if f.is_null() {
                self.error(d).and(Err("no RT filter".into()))
            } else {
                let (w, h) = (input.width, input.height);
                for (name, buf) in [("color", &mut color), ("albedo", &mut albedo), ("normal", &mut normal), ("output", &mut out)] {
                    (self.set_image)(f, c(name).as_ptr(), buf.as_mut_ptr().cast(), FORMAT_FLOAT3, w, h, 0, 0, 0);
                }
                (self.set_bool)(f, c("hdr").as_ptr(), true);
                (self.set_bool)(f, c("srgb").as_ptr(), false);
                (self.set_bool)(f, c("cleanAux").as_ptr(), true);
                (self.set_int)(f, c("quality").as_ptr(), if quality == Quality::High { QUALITY_HIGH } else { QUALITY_BALANCED });
                (self.commit_filter)(f);
                (self.execute_filter)(f);
                let r = self.error(d);
                (self.release_filter)(f);
                r
            };
            (self.release_device)(d);
            r
        };
        r.map(|_| out)
    }
}

// A loaded set stays loaded for the process: a denoise thread may be inside it.
static API: OnceLock<Api> = OnceLock::new();
static NOTE: Mutex<Option<String>> = Mutex::new(None);

/// The loaded library, once `load` found a good set.
pub fn api() -> Option<&'static Api> {
    API.get()
}

/// Why the library is not loaded, after a `load` that did not.
pub fn note() -> Option<String> {
    NOTE.lock().ok().and_then(|n| n.clone())
}

/// Loads this platform's set from `dir` unless a set is loaded already.
/// Called again after a download, so there is no restart.
pub fn load(dir: &Path) -> Result<(), String> {
    if API.get().is_some() {
        return Ok(());
    }
    let r = release().and_then(|rel| Api::open(dir, rel.files)).map(|api| {
        let _ = API.set(api);
    });
    if let Ok(mut n) = NOTE.lock() {
        *n = r.as_ref().err().cloned();
    }
    r
}

/// The folder a release goes into below the app's data folder.
pub fn dir_in(app_data: &Path) -> PathBuf {
    app_data.join("oidn").join(VERSION)
}

/// Unpacks the CPU set of a downloaded archive into `dest`, only when the
/// archive and then every file match their digests. Nothing is run.
pub fn install(archive: &[u8], rel: &Release, dest: &Path) -> Result<(), String> {
    if sha256_hex(archive) != rel.sha256 {
        return Err("the download does not match the pinned release digest".into());
    }
    let tmp = dest.with_extension("part");
    let _ = std::fs::remove_dir_all(&tmp);
    let r = unpack(archive, rel, &tmp).and_then(|_| verify(&tmp, rel.files)).and_then(|_| {
        if dest.exists() {
            std::fs::remove_dir_all(dest).map_err(|e| format!("the old {} could not be replaced ({e})", dest.display()))?;
        }
        std::fs::rename(&tmp, dest).map_err(|e| format!("{} could not be written ({e})", dest.display()))
    });
    if r.is_err() {
        let _ = std::fs::remove_dir_all(&tmp);
    }
    r
}

fn wanted<'a>(rel: &'a Release, name: &str) -> Option<&'a Pinned> {
    let (_, rest) = name.split_once('/')?;
    rel.files.iter().find(|f| f.member == rest)
}

fn put(dir: &Path, f: &Pinned, bytes: &[u8]) -> Result<(), String> {
    let path = dir.join(f.file);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{} could not be made ({e})", parent.display()))?;
    }
    std::fs::write(&path, bytes).map_err(|e| format!("{} could not be written ({e})", path.display()))
}

fn unpack(archive: &[u8], rel: &Release, dir: &Path) -> Result<(), String> {
    let bad = |e: &dyn std::fmt::Display| format!("the archive could not be read ({e})");
    if rel.zip {
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(archive)).map_err(|e| bad(&e))?;
        for i in 0..z.len() {
            let mut entry = z.by_index(i).map_err(|e| bad(&e))?;
            if let Some(f) = wanted(rel, entry.name()) {
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).map_err(|e| bad(&e))?;
                put(dir, f, &bytes)?;
            }
        }
    } else {
        let mut t = tar::Archive::new(flate2::read::GzDecoder::new(archive));
        for entry in t.entries().map_err(|e| bad(&e))? {
            let mut entry = entry.map_err(|e| bad(&e))?;
            if !entry.header().entry_type().is_file() {
                continue;
            }
            let name = entry.path().map_err(|e| bad(&e))?.to_string_lossy().replace('\\', "/");
            if let Some(f) = wanted(rel, &name) {
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).map_err(|e| bad(&e))?;
                put(dir, f, &bytes)?;
            }
        }
    }
    Ok(())
}
