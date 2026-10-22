//! A file arriving inline, in one piece or several, for a host that hands its model bytes but no path.
//! Pieces append to a spool on disk, since decoded and unpacked they may be four times the file's size.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use base64::Engine as _;
use serde_json::{Map, Value};

/// The set the app's file pickers offer, under the names the engine's importer switches on.
pub const IMPORT_FORMATS: &[&str] = &[
    "step", "stl", "3mf", "obj", "brep", "glb", "gltf", "iges", "fcstd", "ply", "off", "amf", "vrml", "x3d", "xbf",
    "3dm", "ifc", "dxf", "fbx", "3ds", "svg",
];

/// Summed over every piece of one upload. A TRANSPORT limit: the engine keeps its own per-format cap,
/// and `path` has none.
pub const MAX_INLINE_BYTES: usize = 64 * 1024 * 1024;

static INLINE_CAP: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(MAX_INLINE_BYTES);

pub fn max_inline_bytes() -> usize {
    INLINE_CAP.load(std::sync::atomic::Ordering::Relaxed)
}

/// Above the engine's 400 MiB STEP cap so nothing the reader would take is refused here, and finite
/// because a few hundred bytes of gzip can expand to a gigabyte of zeroes.
pub const MAX_UNPACKED_BYTES: usize = 512 * 1024 * 1024;

static UNPACKED_CAP: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(MAX_UNPACKED_BYTES);

pub fn max_unpacked_bytes() -> usize {
    UNPACKED_CAP.load(std::sync::atomic::Ordering::Relaxed)
}

/// Moves the two caps and returns the old ones, for a test that provokes the refusal
/// without writing half a gigabyte.
pub fn set_caps(inline: usize, unpacked: usize) -> (usize, usize) {
    use std::sync::atomic::Ordering::Relaxed;
    (INLINE_CAP.swap(inline, Relaxed), UNPACKED_CAP.swap(unpacked, Relaxed))
}

/// Past this many pieces, say so: each piece costs a whole message of the model's output.
pub const PIECES_WORTH_IT: i64 = 5;

/// This process outlives any one conversation, so an abandoned upload would otherwise
/// hold its directory as long as the host runs.
pub const UPLOAD_IDLE_SECONDS: u64 = 30 * 60;

/// Extensions that wrap a file, and what is inside when the name is all there is. `.stpZ` is ISO 10303-21's
/// zipped STEP, though FreeCAD and KiCad write it gzip, which the sniff in `unpack` catches.
const ARCHIVE_SUFFIXES: &[(&str, &str, Option<&str>)] =
    &[("gz", "gzip", None), ("gzip", "gzip", None), ("zip", "zip", None), ("stpz", "zip", Some("step"))];

/// Spellings the file pickers accept that are not the format's own name.
const FORMAT_ALIASES: &[(&str, &str)] =
    &[("stp", "step"), ("igs", "iges"), ("wrl", "vrml"), ("wrz", "vrml"), ("x3dz", "x3d")];

/// A multiple of 4, so a base64 spool splits where the decoder can take one block at a time;
/// padding only ever ends the stream.
const BLOCK: usize = 4 * 1024 * 1024;

/// Written out in full wherever it applies: an agent that decides the part cannot be sent
/// models against something it made up, and every measurement after is wrong.
pub const ASK_FOR_A_PATH: &str = "If you cannot reach the file from where you are, ask the person \
you are working with for its path on the machine FundaCAD runs on, or ask them to open it in \
FundaCAD themselves (File, Import Mesh), which puts it in the document for `inspect` to measure. \
Do not substitute a simplified stand-in for the real part: fitting to an approximation is the \
failure this tool exists to prevent.";

/// A refusal an agent can act on, which is the only kind this module raises.
#[derive(Debug, Clone)]
pub struct UploadError(pub String);

impl std::fmt::Display for UploadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn fail<T>(message: impl Into<String>) -> Result<T, UploadError> {
    Err(UploadError(message.into()))
}

/// In the unit it is actually in, so an upload's progress never reads a few hundred kilobytes as "0.0 MiB".
pub fn size_text(n: usize) -> String {
    if n < 1024 {
        return format!("{n} bytes");
    }
    if n < 1024 * 1024 {
        return format!("{:.0} KiB", n as f64 / 1024.0);
    }
    format!("{:.1} MiB", n as f64 / (1024.0 * 1024.0))
}

fn too_large(size: usize) -> String {
    format!(
        "content reached {}, more than can be sent inline (limit {} MiB). Send it gzipped with \
         compression=\"gzip\", which a STEP file typically shrinks tenfold, or pass path instead, \
         which has no limit at all. {ASK_FOR_A_PATH}",
        size_text(size),
        max_inline_bytes() / (1024 * 1024)
    )
}

/// The format an extension NAMES, kept apart from the guess below: a plain `.zip` names nothing,
/// which is what lets the file inside decide.
pub fn format_of(name: &str) -> Option<&'static str> {
    named_format(&extension(name))
}

/// The format a spelling names, in any case: `STP` and `igs` as much as `step`.
fn named_format(spelling: &str) -> Option<&'static str> {
    let spelling = spelling.to_ascii_lowercase();
    let own = FORMAT_ALIASES.iter().find(|(a, _)| *a == spelling).map_or(spelling.as_str(), |(_, f)| *f);
    IMPORT_FORMATS.iter().copied().find(|f| *f == own)
}

/// A format the caller named: its own name when it is one, else lower case as
/// given, which the caller then refuses by that name.
pub fn format_told_as(told: &str) -> String {
    named_format(told).map_or_else(|| told.to_ascii_lowercase(), str::to_string)
}

/// STEP is the fallback, as in `extToImportFormat` in src/io/files.ts: STEP files come spelled many ways,
/// and refusing the unknown would make the commonest import need an argument.
pub fn import_format(path: &str) -> &'static str {
    format_of(path).unwrap_or("step")
}

fn extension(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    match base.rfind('.') {
        Some(at) if at + 1 < base.len() => base[at + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

fn without_extension(name: &str) -> String {
    match name.rfind('.') {
        Some(at) if name[at..].len() > 1 && !name[at + 1..].contains(['/', '\\']) => name[..at].to_string(),
        _ => name.to_string(),
    }
}

/// (inner name, wrapping) for a name that may be an archive: "asm.step.gz" is a STEP called asm.step,
/// and "asm.stpz" has to be told so, because the zip took its extension away.
pub fn unwrap_name(name: &str) -> (String, Option<&'static str>) {
    let ext = extension(name);
    let Some((_, compression, inside)) = ARCHIVE_SUFFIXES.iter().find(|(e, _, _)| *e == ext) else {
        return (name.to_string(), None);
    };
    let mut inner = without_extension(name);
    if let Some(inside) = inside {
        if format_of(&inner).is_none() {
            inner.push('.');
            inner.push_str(inside);
        }
    }
    (inner, Some(compression))
}

/// Built rather than trusted: ".." survives a basename, and a colon or wildcard cannot be written
/// on Windows. Only the extension is cosmetic, the format is decided before this.
pub fn safe_filename(name: &str, fmt: &str) -> String {
    let base = name.trim().rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '_' })
        .collect();
    if cleaned.trim_matches('.').is_empty() {
        format!("imported.{fmt}")
    } else {
        cleaned
    }
}

/// The first piece settles the name, format and compression; a later piece that contradicts it
/// is refused, since a file whose format changed halfway is not one file.
pub struct Upload {
    pub id: String,
    pub compression: Option<String>,
    /// "none" is the escape hatch for a file really called .gz that is not compressed, so it overrules the bytes too.
    pub sniff: bool,
    pub encoding: String,
    pub told_format: bool,
    pub fmt: String,
    pub name: String,
    pub filename: String,
    pub parts: i64,
    pub got: i64,
    pub touched: Instant,
    pub dir: PathBuf,
    pub spool: PathBuf,
}

impl Upload {
    pub fn new(args: &Map<String, Value>, parts: i64) -> Result<Upload, UploadError> {
        let name = args.get("name").and_then(Value::as_str).unwrap_or("");
        let (inner, wrapped) = unwrap_name(name);

        let given = args.get("compression").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
        let sniff = given != "none";
        let compression = if given == "none" {
            None // an explicit none overrules the name
        } else if !given.is_empty() {
            if given != "gzip" && given != "zip" {
                return fail(format!("Unknown compression '{given}'. Use \"gzip\", \"zip\", or leave it out."));
            }
            Some(given)
        } else {
            wrapped.map(str::to_string)
        };

        let mut encoding = args.get("encoding").and_then(Value::as_str).unwrap_or("base64").to_ascii_lowercase();
        if encoding == "utf8" || encoding == "utf-8" {
            encoding = "text".into();
        }
        if encoding != "base64" && encoding != "text" {
            return fail(format!("Unknown encoding '{encoding}'. Use \"base64\" or \"text\"."));
        }

        // Where the format came from decides one later question: a plain `.zip`
        // tells us nothing, so if nobody has said, the file inside gets to.
        let told = args.get("format").and_then(Value::as_str).filter(|f| !f.is_empty());
        let told_format = told.is_some() || format_of(&inner).is_some();
        let fmt = told.map(format_told_as).unwrap_or_else(|| import_format(&inner).to_string());
        if !IMPORT_FORMATS.contains(&fmt.as_str()) {
            return fail(format!("Cannot import '{fmt}' files. Formats: {}.", IMPORT_FORMATS.join(", ")));
        }

        let id = token_hex(3);
        // A directory of its own, so the name cannot collide with a concurrent
        // import and one removal is the whole clean-up.
        let dir = std::env::temp_dir().join(format!("fundacad-import-{}", token_hex(8)));
        if std::fs::create_dir_all(&dir).is_err() {
            return fail("could not make a place to spool the file.");
        }
        let spool = dir.join("spool");
        Ok(Upload {
            id,
            compression,
            sniff,
            encoding,
            told_format,
            name: if inner.is_empty() { format!("imported.{fmt}") } else { inner.clone() },
            filename: safe_filename(&inner, &fmt),
            fmt,
            parts,
            got: 0,
            touched: Instant::now(),
            dir,
            spool,
        })
    }

    pub fn spooled(&self) -> usize {
        std::fs::metadata(&self.spool).map_or(0, |m| m.len() as usize)
    }

    /// Refuses by name and says which argument would have avoided it, since this is the one layer that knows both.
    pub fn write(&mut self, content: Option<&Value>, part: i64) -> Result<(), UploadError> {
        let Some(Value::String(content)) = content else {
            return fail("content must be a string: base64, or the file's own text with encoding \"text\".");
        };
        let data: Vec<u8> = if self.encoding == "text" {
            content.as_bytes().to_vec()
        } else {
            // Whitespace first: base64 is routinely wrapped at 76 columns and a strict decode refuses a newline.
            let packed: String = content.split_whitespace().collect();
            if part < self.parts && packed.ends_with('=') {
                return fail(format!(
                    "part {part} ends in base64 padding, so it looks separately encoded. Encode \
                     the whole file once and split the text that comes out, otherwise the pieces \
                     cannot be joined back into the file."
                ));
            }
            if !packed.is_ascii() {
                // Not base64 at all, and saying so is preferred over a codec error naming a
                // character offset in something the caller never sees as text.
                return fail(
                    "content is not valid base64. A text format (STEP, OBJ, ASCII STL) can be \
                     sent as it is with encoding \"text\".",
                );
            }
            packed.into_bytes()
        };

        // A spool bound only, so a caller ignoring the limit cannot spool without end;
        // the exact limit is on the decoded bytes as they are written.
        if self.spooled() + data.len() > max_inline_bytes() / 3 * 4 + 64 {
            return fail(too_large(self.spooled() * 3 / 4));
        }
        let appended = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.spool)
            .and_then(|mut fh| fh.write_all(&data));
        if appended.is_err() {
            return fail("the file could not be spooled to disk.");
        }
        self.got = part;
        self.touched = Instant::now();
        Ok(())
    }

    pub fn drop_files(&self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn token_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    if getrandom::fill(&mut buf).is_err() {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64);
        for (i, b) in buf.iter_mut().enumerate() {
            *b = (n >> (i * 8)) as u8;
        }
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Streamed a block at a time; the block is a multiple of 4, so each read is whole base64 groups.
fn decode_spool(up: &Upload, out_path: &Path) -> Result<usize, UploadError> {
    let Ok(mut src) = std::fs::File::open(&up.spool) else {
        return fail("content is empty.");
    };
    let Ok(mut dst) = std::fs::File::create(out_path) else {
        return fail("the file could not be written to disk.");
    };
    let mut total = 0usize;
    let mut block = vec![0u8; BLOCK];
    loop {
        let mut filled = 0;
        while filled < BLOCK {
            match src.read(&mut block[filled..]) {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(_) => return fail("the spooled file could not be read back."),
            }
        }
        if filled == 0 {
            break;
        }
        let data = if up.encoding == "text" {
            block[..filled].to_vec()
        } else {
            match base64::engine::general_purpose::STANDARD.decode(&block[..filled]) {
                Ok(d) => d,
                Err(_) => {
                    return fail(
                        "content is not valid base64. A text format (STEP, OBJ, ASCII STL) can be \
                         sent as it is with encoding \"text\". Pieces have to be one file's \
                         base64 split into parts, not a part each.",
                    )
                }
            }
        };
        total += data.len();
        if total > max_inline_bytes() {
            return fail(too_large(total));
        }
        if dst.write_all(&data).is_err() {
            return fail("the file could not be written to disk.");
        }
        if filled < BLOCK {
            break;
        }
    }
    if total == 0 {
        return fail("content is empty.");
    }
    Ok(total)
}

/// gzip alone, from its first two bytes: a 3MF IS a zip the engine reads as one, so a zip
/// has to be declared, while nothing we read begins 1f 8b.
fn sniff_compression(path: &Path) -> Option<&'static str> {
    let mut head = [0u8; 2];
    let mut fh = std::fs::File::open(path).ok()?;
    fh.read_exact(&mut head).ok()?;
    (head == [0x1f, 0x8b]).then_some("gzip")
}

fn copy_capped(src: &mut impl Read, dst: &mut impl Write, what: &str) -> Result<usize, UploadError> {
    let mut total = 0usize;
    let mut block = vec![0u8; BLOCK];
    loop {
        let n = match src.read(&mut block) {
            Ok(0) => return Ok(total),
            Ok(n) => n,
            Err(e) => return fail(format!("{what} could not be read ({e}).")),
        };
        total += n;
        if total > max_unpacked_bytes() {
            return fail(format!(
                "{what} is over {} once unpacked, which is more than will be read from an \
                 archive. Send the file itself, or pass path.",
                size_text(max_unpacked_bytes())
            ));
        }
        if dst.write_all(&block[..n]).is_err() {
            return fail("the file could not be written to disk.");
        }
    }
}

fn gunzip(src_path: &Path, dst_path: &Path) -> Result<usize, UploadError> {
    let Ok(src) = std::fs::File::open(src_path) else {
        return fail("the gzip data could not be read. If the file is not compressed, leave compression out.");
    };
    let Ok(mut dst) = std::fs::File::create(dst_path) else {
        return fail("the file could not be written to disk.");
    };
    let mut decoder = flate2::read::MultiGzDecoder::new(src);
    match copy_capped(&mut decoder, &mut dst, "the file") {
        Ok(n) => Ok(n),
        Err(e) if e.0.starts_with("the file could not be read") => fail(format!(
            "the gzip data could not be read ({}). If the file is not compressed, leave \
             compression out.",
            e.0.trim_start_matches("the file could not be read (").trim_end_matches(").")
        )),
        Err(e) => Err(e),
    }
}

/// An archive holding several files is refused rather than guessed at, since importing the wrong one
/// looks like success until the measurements are wrong.
fn unzip_one(src_path: &Path, dst_path: &Path, fmt: &str, told_format: bool) -> Result<String, UploadError> {
    let Ok(file) = std::fs::File::open(src_path) else {
        return fail("the zip archive could not be read. If the file is not compressed, leave compression out.");
    };
    let mut z = match zip::ZipArchive::new(file) {
        Ok(z) => z,
        Err(e) => {
            return fail(format!(
                "the zip archive could not be read ({e}). If the file is not compressed, leave \
                 compression out."
            ))
        }
    };
    let mut entries: Vec<(usize, String, u64)> = Vec::new();
    for i in 0..z.len() {
        let Ok(e) = z.by_index_raw(i) else { continue };
        if e.is_dir() {
            continue;
        }
        entries.push((i, e.name().to_string(), e.size()));
    }
    if entries.is_empty() {
        return fail("the archive holds no files.");
    }
    let chosen = if entries.len() == 1 {
        entries[0].clone()
    } else {
        // Only a format somebody stated may choose: `fmt` falls back to step whenever the name was silent.
        let want: Vec<&(usize, String, u64)> = if told_format {
            entries.iter().filter(|(_, name, _)| format_of(name) == Some(fmt)).collect()
        } else {
            Vec::new()
        };
        if want.len() != 1 {
            let mut names: Vec<String> = entries.iter().map(|(_, n, _)| n.clone()).collect();
            names.sort();
            names.truncate(8);
            return fail(format!(
                "the archive holds {} files ({}). Send the one to import on its own, or name its \
                 format.",
                entries.len(),
                names.join(", ")
            ));
        }
        want[0].clone()
    };
    let (index, name, declared) = chosen;
    if declared as usize > max_unpacked_bytes() {
        return fail(format!(
            "{name} is {} unpacked, more than the {} an archive is read up to. Pass path.",
            size_text(declared as usize),
            size_text(max_unpacked_bytes())
        ));
    }
    let Ok(mut entry) = z.by_index(index) else {
        return fail(format!("{name} could not be read out of the archive."));
    };
    let Ok(mut dst) = std::fs::File::create(dst_path) else {
        return fail("the file could not be written to disk.");
    };
    let total = copy_capped(&mut entry, &mut dst, &name)?;
    // A zip states each entry's size, so a mismatch means damage, and a short read would import a truncated file.
    if total as u64 != declared {
        return fail(format!("{name} says it is {declared} bytes but {total} came out, so the archive is damaged."));
    }
    Ok(name)
}

pub fn unpack(up: &mut Upload) -> Result<PathBuf, UploadError> {
    let payload = up.dir.join("payload");
    decode_spool(up, &payload)?;
    let mut compression = up.compression.clone();
    if up.sniff {
        if let Some(seen) = sniff_compression(&payload) {
            compression = Some(seen.to_string());
        }
    }
    let final_path = up.dir.join(&up.filename);
    let Some(compression) = compression else {
        if std::fs::rename(&payload, &final_path).is_err() {
            return fail("the file could not be written to disk.");
        }
        return Ok(final_path);
    };
    if compression == "gzip" {
        gunzip(&payload, &final_path)?;
    } else {
        let inside = unzip_one(&payload, &final_path, &up.fmt, up.told_format)?;
        // Nobody named a format and the archive's own extension could not, so
        // the file inside is the only thing left that knows.
        if !up.told_format {
            if let Some(fmt) = format_of(&inside) {
                up.fmt = fmt.to_string();
            }
        }
    }
    let _ = std::fs::remove_file(&payload);
    Ok(final_path)
}
