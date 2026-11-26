//! The UI's text in the person's language, FundaCAD 1's src/i18n with its locale files and keys. Each line is looked up
//! in the person's own language file, then the shipped file, then English, and a line that does not parse falls to the
//! next. `t` and `tr!` read the current catalog, `set_language` or `choose` swaps it.

mod decimal;
mod format;
mod languages;
mod overrides;
mod pseudo;

#[cfg(test)]
mod catalog_tests;
#[cfg(test)]
mod decimal_tests;
#[cfg(test)]
mod format_tests;
#[cfg(test)]
mod languages_tests;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, OnceLock, PoisonError, RwLock};

use gpui::{App, SharedString};

pub use decimal::{read_typed, show_stored};
pub use format::Arg;
pub use languages::{PSEUDO, SHIPPED};
pub use overrides::{FileError, SkipReason};

use format::Node;
use languages::ReadError;

/// The settings key of the language: "system", a shipped code, "pseudo" in a debug build, or the code of an own file.
pub const SETTING: &str = "language";
pub const SYSTEM: &str = "system";

const LOCALES: [(&str, &str); 6] = [
    ("en", include_str!("locales/en.json")),
    ("de", include_str!("locales/de.json")),
    ("es", include_str!("locales/es.json")),
    ("fr", include_str!("locales/fr.json")),
    ("ja", include_str!("locales/ja.json")),
    ("zh-CN", include_str!("locales/zh-CN.json")),
];

type Table = HashMap<String, String>;

fn parse_table(text: &str) -> Table {
    serde_json::from_str(text).unwrap_or_else(|e| {
        log::warn!("a shipped language file did not read, its lines fall back to English: {e}");
        Table::new()
    })
}

fn english_table() -> &'static Table {
    static EN: LazyLock<Table> = LazyLock::new(|| parse_table(LOCALES[0].1));
    &EN
}

/// The shipped file of `code`, a regional code's base included, so de-AT reads de.json. zh-TW finds no zh.json.
fn shipped_table(code: &str) -> Option<&'static Table> {
    static TABLES: [OnceLock<Table>; 6] = [const { OnceLock::new() }; 6];
    let base = code.split('-').next().unwrap_or(code);
    let i = LOCALES.iter().position(|(c, _)| *c == code).or_else(|| LOCALES.iter().position(|(c, _)| *c == base))?;
    (i > 0).then(|| TABLES[i].get_or_init(|| parse_table(LOCALES[i].1)))
}

type Parsed = Option<Arc<Vec<Node>>>;

fn compiled(src: &str) -> Parsed {
    static CACHE: LazyLock<Mutex<HashMap<String, Parsed>>> = LazyLock::new(Default::default);
    let mut cache = CACHE.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(nodes) = cache.get(src) {
        return nodes.clone();
    }
    let nodes = match format::parse(src) {
        Ok(nodes) => Some(Arc::new(nodes)),
        Err(e) => {
            log::warn!("a language line did not parse, the next source is used: {} in {src:?}", e.0);
            None
        }
    };
    cache.insert(src.to_owned(), nodes.clone());
    nodes
}

fn pseudo_compiled(key: &str) -> Parsed {
    static CACHE: LazyLock<Mutex<HashMap<String, Parsed>>> = LazyLock::new(Default::default);
    let mut cache = CACHE.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(nodes) = cache.get(key) {
        return nodes.clone();
    }
    let nodes = english_table().get(key).and_then(|src| compiled(src)).map(|n| Arc::new(pseudo::pseudo_nodes(&n)));
    cache.insert(key.to_owned(), nodes.clone());
    nodes
}

/// What the person's own language file did: the lines it gave, the ones skipped and why, or why it was refused.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DropInStatus {
    pub lines: usize,
    pub skipped: Vec<(String, SkipReason)>,
    pub error: Option<FileError>,
}

pub struct Catalog {
    code: String,
    bcp47: String,
    shipped: Option<&'static Table>,
    drop_in: Table,
    status: Option<DropInStatus>,
}

impl Catalog {
    pub fn english() -> Self {
        Self::new("en", None)
    }

    /// The catalog of `code` with the text of the person's own file for it, if there is one.
    pub fn new(code: &str, own_file: Option<&str>) -> Self {
        Self::with_file(code, own_file.map(|t| Ok(t.to_owned())))
    }

    fn with_file(code: &str, own_file: Option<Result<String, ReadError>>) -> Self {
        let bcp47 = match code {
            PSEUDO => languages::PSEUDO_LANGUAGE.bcp47.to_owned(),
            c => languages::shipped(c).map_or(c, |l| l.bcp47).to_owned(),
        };
        let (drop_in, status) = match own_file {
            None => (Table::new(), None),
            Some(Ok(text)) => {
                let o = overrides::parse_overrides(&text, english_table());
                let status = DropInStatus { lines: o.lines.len(), skipped: o.skipped, error: o.error };
                (o.lines, Some(status))
            }
            Some(Err(e)) => {
                let error = match e {
                    ReadError::TooLarge => FileError::TooLarge,
                    ReadError::NotUtf8 => FileError::NotUtf8,
                    ReadError::Other(why) => {
                        log::warn!("the {code} language file could not be read: {why}");
                        FileError::NotRead
                    }
                };
                (Table::new(), Some(DropInStatus { error: Some(error), ..Default::default() }))
            }
        };
        let shipped = if code == PSEUDO { None } else { shipped_table(code) };
        Self { code: code.to_owned(), bcp47, shipped, drop_in, status }
    }

    #[allow(dead_code, reason = "the preferences lane reads it")]
    pub fn code(&self) -> &str {
        &self.code
    }

    #[allow(dead_code, reason = "the preferences lane reads it")]
    pub fn bcp47(&self) -> &str {
        &self.bcp47
    }

    pub fn decimal_mark(&self) -> char {
        format::decimal_mark(&self.bcp47)
    }

    #[allow(dead_code, reason = "the preferences lane reads it")]
    pub fn status(&self) -> Option<&DropInStatus> {
        self.status.as_ref()
    }

    /// The line of `key` with `args` filled in, the key itself when no source has it.
    pub fn text(&self, key: &str, args: &[(&str, Arg)]) -> String {
        if self.code == PSEUDO {
            return pseudo_compiled(key).map_or_else(|| key.to_owned(), |n| format::format(&n, args, "en", "en"));
        }
        let sources = [self.drop_in.get(key), self.shipped.and_then(|s| s.get(key)), english_table().get(key)];
        for (i, src) in sources.iter().enumerate() {
            let Some(nodes) = src.and_then(|s| compiled(s)) else { continue };
            let plurals = if i == sources.len() - 1 { "en" } else { self.bcp47.as_str() };
            return format::format(&nodes, args, &self.bcp47, plurals);
        }
        key.to_owned()
    }
}

struct State {
    setting: String,
    catalog: Arc<Catalog>,
    dir: Option<PathBuf>,
    own_files: Vec<String>,
}

static STATE: LazyLock<RwLock<State>> = LazyLock::new(|| {
    RwLock::new(State {
        setting: SYSTEM.to_owned(),
        catalog: Arc::new(Catalog::english()),
        dir: None,
        own_files: Vec::new(),
    })
});

/// The catalog in use. Until `init` runs everything is English, which is what a test that never calls it gets.
pub fn current() -> Arc<Catalog> {
    STATE.read().unwrap_or_else(PoisonError::into_inner).catalog.clone()
}

pub fn t(key: &str) -> String {
    current().text(key, &[])
}

pub fn t_with(key: &str, args: &[(&str, Arg)]) -> String {
    current().text(key, args)
}

/// The English line whatever the language, for a name a person may also type.
#[allow(dead_code, reason = "the parameters and preferences lanes read it")]
pub fn english(key: &str, args: &[(&str, Arg)]) -> String {
    Catalog::english().text(key, args)
}

/// `tr!("export.done", n = 3)` is `t_with("export.done", &[("n", 3.into())])`.
macro_rules! tr {
    ($key:expr $(,)?) => {
        $crate::i18n::t($key)
    };
    ($key:expr, $($name:ident = $value:expr),+ $(,)?) => {
        $crate::i18n::t_with($key, &[$((stringify!($name), $crate::i18n::Arg::from($value))),+])
    };
}
pub(crate) use tr;

/// The code of the language in use, as "de" or "pseudo".
#[allow(dead_code, reason = "the preferences lane reads it")]
pub fn language() -> String {
    current().code.clone()
}

/// What the person picked, "system" or a code.
#[allow(dead_code, reason = "the preferences lane reads it")]
pub fn setting() -> String {
    STATE.read().unwrap_or_else(PoisonError::into_inner).setting.clone()
}

pub fn decimal_mark() -> char {
    current().decimal_mark()
}

/// The folder the person's own language files live in.
pub fn languages_dir() -> Option<PathBuf> {
    crate::settings::config_dir().map(|d| d.join("languages"))
}

fn pseudo_offered() -> bool {
    cfg!(debug_assertions)
}

/// The OS languages as BCP 47 tags, read from the POSIX locale variables, none on Windows.
fn system_tags() -> Vec<String> {
    ["LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .filter_map(|v| std::env::var(v).ok())
        .flat_map(|v| v.split(':').map(str::to_owned).collect::<Vec<_>>())
        .filter_map(|v| {
            let tag = v.split(['.', '@']).next()?.replace('_', "-");
            (!tag.is_empty() && tag != "C" && tag != "POSIX").then_some(tag)
        })
        .collect()
}

/// The code a setting means now, given the own files there are.
fn resolve(setting: &str, own_files: &[String]) -> String {
    let known = |v: &str| {
        languages::shipped(v).is_some() || (v == PSEUDO && pseudo_offered()) || own_files.iter().any(|c| c == v)
    };
    if setting != SYSTEM && known(setting) {
        return setting.to_owned();
    }
    let offered: Vec<&str> = SHIPPED.iter().filter(|l| l.follows_system).map(|l| l.code).collect();
    languages::match_system_language(&system_tags(), &offered)
}

/// Swaps the catalog for `setting`'s language, reading the own file of that language if there is one. Returns what
/// the own file did, None when there is none.
pub fn set_language(setting: &str) -> Option<DropInStatus> {
    let (dir, own_files) = {
        let s = STATE.read().unwrap_or_else(PoisonError::into_inner);
        (s.dir.clone(), s.own_files.clone())
    };
    let code = resolve(setting, &own_files);
    let file = match &dir {
        Some(dir) if own_files.contains(&code) => languages::read(dir, &code).transpose(),
        _ => None,
    };
    let catalog = Arc::new(Catalog::with_file(&code, file));
    let status = catalog.status.clone();
    let mut s = STATE.write().unwrap_or_else(PoisonError::into_inner);
    s.setting = setting.to_owned();
    s.catalog = catalog;
    status
}

/// Lists the languages folder again and reapplies the setting, for Reload after the person edited a file.
#[allow(dead_code, reason = "the preferences lane calls it")]
pub fn reload_language_files() -> Option<DropInStatus> {
    let setting = {
        let mut s = STATE.write().unwrap_or_else(PoisonError::into_inner);
        s.own_files = s.dir.as_deref().map(languages::list).unwrap_or_default();
        s.setting.clone()
    };
    set_language(&setting)
}

/// One row of the language picker.
#[derive(Clone, Debug, PartialEq)]
pub struct Choice {
    pub code: String,
    pub native: String,
    pub machine: Option<&'static str>,
    pub own_file: bool,
}

/// The languages the picker offers besides System: the shipped ones, pseudo in a debug build, then own files.
#[allow(dead_code, reason = "the preferences lane reads it")]
pub fn choices() -> Vec<Choice> {
    let own_files = STATE.read().unwrap_or_else(PoisonError::into_inner).own_files.clone();
    let mut out: Vec<Choice> = SHIPPED
        .iter()
        .chain(pseudo_offered().then_some(&languages::PSEUDO_LANGUAGE))
        .map(|l| Choice {
            code: l.code.to_owned(),
            native: l.native.to_owned(),
            machine: l.machine,
            own_file: own_files.iter().any(|c| c == l.code),
        })
        .collect();
    for code in own_files.iter().filter(|c| languages::shipped(c).is_none()) {
        out.push(Choice { code: code.clone(), native: code.clone(), machine: None, own_file: true });
    }
    out
}

/// Reads the language setting and the own files folder, before the first window draws.
pub fn init(cx: &mut App) {
    let dir = languages_dir();
    {
        let mut s = STATE.write().unwrap_or_else(PoisonError::into_inner);
        s.own_files = dir.as_deref().map(languages::list).unwrap_or_default();
        s.dir = dir;
    }
    let setting: String = crate::settings::get(cx, SETTING).unwrap_or_else(|| SYSTEM.to_owned());
    if let Some(DropInStatus { error: Some(e), .. }) = set_language(&setting) {
        log::warn!("the own language file was refused: {e:?}");
    }
}

/// Saves and applies a language picked in Preferences, and redraws every window in it.
#[allow(dead_code, reason = "the preferences lane calls it")]
pub fn choose(cx: &mut App, setting: &str) -> Option<DropInStatus> {
    crate::settings::set(cx, SETTING, &setting);
    let status = set_language(setting);
    cx.refresh_windows();
    status
}

pub type LabelArgs = &'static [(&'static str, &'static str)];

/// A label that reads in the language in use whenever it is shown, so a language change needs no re-registering.
#[derive(Clone, Debug, PartialEq)]
pub enum Label {
    Text(SharedString),
    Key(&'static str),
    /// A command's key, its trailing ellipsis dropped: the menu adds its own to a row that opens a dialog.
    Command(&'static str),
    With(&'static str, LabelArgs),
}

impl Label {
    pub fn text(&self) -> SharedString {
        match self {
            Label::Text(s) => s.clone(),
            Label::Key(key) => t(key).into(),
            Label::Command(key) => {
                let line = t(key);
                let (body, close) = line.strip_suffix(']').map_or((line.as_str(), ""), |b| (b, "]"));
                format!("{}{close}", body.trim_end_matches(['…', '.']).trim_end()).into()
            }
            Label::With(key, args) => {
                let args: Vec<(&str, Arg)> = args.iter().map(|(n, v)| (*n, Arg::from(*v))).collect();
                t_with(key, &args).into()
            }
        }
    }
}

impl From<&'static str> for Label {
    fn from(v: &'static str) -> Self {
        Label::Text(v.into())
    }
}

impl From<String> for Label {
    fn from(v: String) -> Self {
        Label::Text(v.into())
    }
}

impl From<SharedString> for Label {
    fn from(v: SharedString) -> Self {
        Label::Text(v)
    }
}
