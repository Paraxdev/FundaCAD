//! A file arriving inline, in one piece or in several. The upload half of
//! `crates/fundacad-mcp/tools/python-oracle/server.py`.
//!
//! `doc_import` takes a `path`, which assumes the file is on the machine
//! FundaCAD runs on. Often it is not: a host that hands its model an upload
//! gives it the bytes and nothing else. So the file can be sent inline instead,
//! and three things make that practical for a real part rather than a toy one:
//! an encoding that does not re-encode text formats, compression (a STEP is
//! text and gzips about tenfold), and pieces, because the ceiling on one
//! message is the model's output and not this process's memory.
//!
//! The pieces are appended to a spool on disk rather than joined in memory:
//! what arrives may be four times the size of the file once decoded and
//! unpacked, and holding the payload, the bytes and the write at once is three
//! copies of something already at the edge of what a message can carry.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use base64::Engine as _;
use serde_json::{Map, Value};

/// What `doc_import` will read. The same set the app's file pickers offer, and
/// the same names the engine's importer switches on.
pub const IMPORT_FORMATS: &[&str] = &["step", "stl", "3mf", "obj", "brep", "glb"];

/// How much file may arrive inline, summed over every piece of one upload. A
/// TRANSPORT limit, not the reader's: the engine keeps its own per-format cap
/// and applies it to the file on disk. `path` has no ceiling at all.
pub const MAX_INLINE_BYTES: usize = 64 * 1024 * 1024;

static INLINE_CAP: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(MAX_INLINE_BYTES);

pub fn max_inline_bytes() -> usize {
    INLINE_CAP.load(std::sync::atomic::Ordering::Relaxed)
}

/// How much may be WRITTEN once an archive is opened. Deliberately above the
/// engine's own 400 MiB STEP cap, so nothing is refused here that the reader
/// would have accepted, and finite because the ratio between an archive and its
/// contents has no upper bound: a few hundred bytes of gzip expands to a
/// gigabyte of zeroes, and a limit only on what arrives is not a limit at all.
pub const MAX_UNPACKED_BYTES: usize = 512 * 1024 * 1024;

static UNPACKED_CAP: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(MAX_UNPACKED_BYTES);

pub fn max_unpacked_bytes() -> usize {
    UNPACKED_CAP.load(std::sync::atomic::Ordering::Relaxed)
}

/// Move the two caps, and give back what they were. The only caller is a test
/// that has to provoke the refusal: the assertion is about what is said when a
/// file is too large, not about writing half a gigabyte to find out.
pub fn set_caps(inline: usize, unpacked: usize) -> (usize, usize) {
    use std::sync::atomic::Ordering::Relaxed;
    (
        INLINE_CAP.swap(inline, Relaxed),
        UNPACKED_CAP.swap(unpacked, Relaxed),
    )
}

/// Past this many pieces, say so. Inline content is written by the model, so
/// every piece costs a whole message of its output whatever this server's own
/// limit is.
pub const PIECES_WORTH_IT: i64 = 5;

/// When pieces nobody came back for are dropped. This process outlives any one
/// conversation, so an upload abandoned halfway would otherwise hold its
/// directory for as long as the host runs.
pub const UPLOAD_IDLE_SECONDS: u64 = 30 * 60;

/// Extensions that wrap a file rather than being one, and what is inside when
/// the name is all there is to go on. `.stpZ` is ISO 10303-21's own spelling
/// for a zipped STEP and carries no inner extension to read.
const ARCHIVE_SUFFIXES: &[(&str, &str, Option<&str>)] = &[
    ("gz", "gzip", None),
    ("gzip", "gzip", None),
    ("zip", "zip", None),
    ("stpz", "zip", Some("step")),
];

/// Spellings the file pickers accept that are not the format's own name.
const FORMAT_ALIASES: &[(&str, &str)] = &[("stp", "step")];

/// Read and written in multiples of 4, so that a base64 spool splits at
/// character boundaries the decoder can take one block at a time. Padding only
/// ever appears at the very end, which is what makes that legal.
const BLOCK: usize = 4 * 1024 * 1024;

/// What to do when the file cannot come this way. Written out in full wherever
/// the question arises, because the wrong answer to it is expensive and quiet:
/// an agent that decides the part cannot be sent will model against something
/// it made up, and everything it measures afterwards will be self-consistent
/// and wrong.
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

/// A size in the unit it is actually in. The progress line on an upload reads a
/// few hundred kilobytes as "0.0 MiB", which is the one number the caller is
/// watching and the one that has to look like it moved.
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

/// The format an extension NAMES, or None when it names nothing we read.
///
/// Kept apart from the guess below because the difference matters in one place:
/// what to do about a plain `.zip`, whose own extension says nothing about its
/// contents. Knowing that the name was silent is what makes reading the answer
/// off the file inside it correct rather than a second guess.
pub fn format_of(name: &str) -> Option<&'static str> {
    let ext = extension(name);
    let ext = FORMAT_ALIASES
        .iter()
        .find(|(a, _)| *a == ext)
        .map_or(ext.as_str(), |(_, f)| *f);
    IMPORT_FORMATS.iter().copied().find(|f| *f == ext)
}

/// The format an extension implies. STEP is the fallback rather than an error,
/// mirroring `extToImportFormat` in src/io/files.ts and for its reason: a STEP
/// file is spelled .step, .stp, .STP and occasionally nothing recognisable, so
/// a lookup table that refused what it did not know would turn the commonest
/// import into the one that needs an argument.
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
        Some(at) if name[at..].len() > 1 && !name[at + 1..].contains(['/', '\\']) => {
            name[..at].to_string()
        }
        _ => name.to_string(),
    }
}

/// (the name of the file inside, how it is wrapped) for a name that may be an
/// archive. "asm.step.gz" is a STEP called asm.step; "asm.stpz" is one too, and
/// has to be told so, because the zip took its extension away.
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

/// A filename for inline content, built rather than trusted.
///
/// `name` is whatever the agent called the file and it is about to become a
/// path on this machine, so taking the basename is the least of it: ".."
/// survives that, and a colon or a wildcard is simply unwritable on Windows,
/// which would turn an ordinary import into an error raised from the wrong
/// layer entirely. Only the extension is cosmetic here anyway, the format is
/// decided before this.
pub fn safe_filename(name: &str, fmt: &str) -> String {
    let base = name.trim().rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.trim_matches('.').is_empty() {
        format!("imported.{fmt}")
    } else {
        cleaned
    }
}

/// A file arriving inline, in one piece or in several.
///
/// Everything about the file (its name, its format, how it is compressed) is
/// settled by the FIRST piece and is not revisited. A later piece that
/// contradicts it is refused rather than reconciled: the pieces are a transport
/// detail, and a file whose format changed halfway through is not one file.
pub struct Upload {
    pub id: String,
    pub compression: Option<String>,
    /// Whether to look at the bytes at all. Saying "none" is the escape hatch
    /// for a file that really is called .gz and really is not compressed, so it
    /// overrules what the bytes look like too.
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

        let given = args
            .get("compression")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let sniff = given != "none";
        let compression = if given == "none" {
            None // an explicit none overrules the name
        } else if !given.is_empty() {
            if given != "gzip" && given != "zip" {
                return fail(format!(
                    "Unknown compression '{given}'. Use \"gzip\", \"zip\", or leave it out."
                ));
            }
            Some(given)
        } else {
            wrapped.map(str::to_string)
        };

        let mut encoding = args
            .get("encoding")
            .and_then(Value::as_str)
            .unwrap_or("base64")
            .to_ascii_lowercase();
        if encoding == "utf8" || encoding == "utf-8" {
            encoding = "text".into();
        }
        if encoding != "base64" && encoding != "text" {
            return fail(format!(
                "Unknown encoding '{encoding}'. Use \"base64\" or \"text\"."
            ));
        }

        // Where the format came from decides one later question: a plain `.zip`
        // tells us nothing, so if nobody has said, the file inside gets to.
        let told = args
            .get("format")
            .and_then(Value::as_str)
            .filter(|f| !f.is_empty());
        let told_format = told.is_some() || format_of(&inner).is_some();
        let fmt = told
            .map(str::to_ascii_lowercase)
            .unwrap_or_else(|| import_format(&inner).to_string());
        if !IMPORT_FORMATS.contains(&fmt.as_str()) {
            return fail(format!(
                "Cannot import '{fmt}' files. Formats: {}.",
                IMPORT_FORMATS.join(", ")
            ));
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
            name: if inner.is_empty() {
                format!("imported.{fmt}")
            } else {
                inner.clone()
            },
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

    /// Append one piece, refusing by name and saying which argument would have
    /// avoided it, because this is the one layer that knows both.
    pub fn write(&mut self, content: Option<&Value>, part: i64) -> Result<(), UploadError> {
        let Some(Value::String(content)) = content else {
            return fail(
                "content must be a string: base64, or the file's own text with encoding \"text\".",
            );
        };
        let data: Vec<u8> = if self.encoding == "text" {
            content.as_bytes().to_vec()
        } else {
            // Whitespace goes first because base64 is routinely wrapped at 76
            // columns, and a strict decode refuses a newline: validating what
            // arrived verbatim would reject the well-formed payload far more
            // often than the malformed one.
            let packed: String = content.split_whitespace().collect();
            if part < self.parts && packed.ends_with('=') {
                return fail(format!(
                    "part {part} ends in base64 padding, so it looks separately encoded. Encode \
                     the whole file once and split the text that comes out, otherwise the pieces \
                     cannot be joined back into the file."
                ));
            }
            if !packed.is_ascii() {
                // Not base64 at all, and saying so beats a codec error naming a
                // character offset in something the caller never sees as text.
                return fail(
                    "content is not valid base64. A text format (STEP, OBJ, ASCII STL) can be \
                     sent as it is with encoding \"text\".",
                );
            }
            packed.into_bytes()
        };

        // A spool bound, not the real one: the exact limit is on the DECODED
        // bytes and is checked as they are written. This exists only so that a
        // caller ignoring the limit cannot spool without bound before finding out.
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
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos() as u64);
        for (i, b) in buf.iter_mut().enumerate() {
            *b = (n >> (i * 8)) as u8;
        }
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// The spool, as the bytes that were sent. Streamed a block at a time, and the
/// block is a multiple of 4, so each read is a whole number of base64 groups
/// and decodes on its own.
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

/// gzip, from its first two bytes, and gzip alone.
///
/// A 3MF IS a zip archive and the engine reads it as one, so unpacking anything
/// that merely looked like a zip would quietly turn a 3MF import into whatever
/// happened to sit inside it. A zip has to be declared, by the argument or by
/// the name; nothing we read begins 1f 8b, so gzip can be recognised on sight.
fn sniff_compression(path: &Path) -> Option<&'static str> {
    let mut head = [0u8; 2];
    let mut fh = std::fs::File::open(path).ok()?;
    fh.read_exact(&mut head).ok()?;
    (head == [0x1f, 0x8b]).then_some("gzip")
}

fn copy_capped(
    src: &mut impl Read,
    dst: &mut impl Write,
    what: &str,
) -> Result<usize, UploadError> {
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
            e.0.trim_start_matches("the file could not be read (")
                .trim_end_matches(").")
        )),
        Err(e) => Err(e),
    }
}

/// Take the one file out of a zip, and say what it was called.
///
/// An archive holding several is refused rather than guessed at: which one was
/// meant is a question with a right answer that this process does not have, and
/// importing the wrong one looks like success until the measurements are wrong.
fn unzip_one(
    src_path: &Path,
    dst_path: &Path,
    fmt: &str,
    told_format: bool,
) -> Result<String, UploadError> {
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
        // Only a format somebody actually stated may choose. `fmt` falls back
        // to step whenever the name was silent, and letting that pick would
        // answer the question with a default.
        let want: Vec<&(usize, String, u64)> = if told_format {
            entries
                .iter()
                .filter(|(_, name, _)| format_of(name) == Some(fmt))
                .collect()
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
    // Declared against actual. A zip states each entry's size in its own
    // directory, so the two disagreeing means the archive is damaged, and a
    // short read would otherwise import as a truncated file.
    if total as u64 != declared {
        return fail(format!(
            "{name} says it is {declared} bytes but {total} came out, so the archive is damaged."
        ));
    }
    Ok(name)
}

/// Everything spooled, as one file the engine can open. Returns its path.
pub fn unpack(up: &mut Upload) -> Result<PathBuf, UploadError> {
    let payload = up.dir.join("payload");
    decode_spool(up, &payload)?;
    let mut compression = up.compression.clone();
    if compression.is_none() && up.sniff {
        compression = sniff_compression(&payload).map(str::to_string);
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
