//! What the transfer dialogs decide without the UI.

use fundacad_client::transfer::export::{BodyScope, ExportFormat, FlatSource, Stamp};
use fundacad_client::transfer::files;
use fundacad_client::transfer::insert::{InsertError, StaleLinks};
use fundacad_client::Doc;
use serde_json::Value;

use crate::i18n::{t, tr};

/// A typed number in a language that writes `mark`: None for text that is no number, an error for a point that
/// could be either mark.
pub fn typed_number(text: &str, mark: char) -> Result<Option<f64>, String> {
    let text = crate::i18n::read_typed(text.trim(), mark).map_err(|e| e.to_string())?;
    Ok(text.parse::<f64>().ok())
}

/// Every sketch of the document, which a DXF or SVG export can draw.
pub fn flat_sources(doc: &Doc) -> Vec<FlatSource> {
    let features = doc.get("features").and_then(Value::as_array).into_iter().flatten();
    features
        .filter(|f| f.get("type").and_then(Value::as_str) == Some("sketch"))
        .filter_map(|f| {
            let id = f.get("id").and_then(Value::as_str)?;
            let label = f.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()).unwrap_or(id);
            Some(FlatSource::Sketch { sketch: id.into(), label: label.into() })
        })
        .collect()
}

/// The scopes a 3D export offers, the selected ones only with bodies selected.
pub fn scope_choices(selected: usize) -> Vec<(BodyScope, String)> {
    let mut out = vec![(BodyScope::All, t("export.scope.all")), (BodyScope::Separate, t("export.scope.separate"))];
    if selected > 0 {
        out.push((BodyScope::Selected, tr!("export.scope.selected", n = selected)));
        out.push((BodyScope::SelectedSeparate, tr!("export.scope.selectedSeparate", n = selected)));
    }
    out
}

/// The saved path with the format's extension, added when the dialog left it off or put another on.
pub fn with_ext(path: &str, format: ExportFormat) -> String {
    let file = files::base_name(path);
    let has = file.rsplit_once('.').is_some_and(|(_, e)| format.info().exts.iter().any(|x| x.eq_ignore_ascii_case(e)));
    if has {
        path.to_owned()
    } else {
        format!("{path}.{}", format.ext())
    }
}

/// Adds features at the end of the history.
pub fn append_features(doc: &mut Doc, features: &[Value]) -> Result<(), String> {
    let list = doc.entry("features").or_insert_with(|| Value::Array(Vec::new()));
    let list = list.as_array_mut().ok_or("the document's features are not a list")?;
    list.extend(features.iter().cloned());
    Ok(())
}

/// The file a linked import reads from.
pub fn link_path(doc: &Doc, feature_id: &str) -> Option<String> {
    let features = doc.get("features")?.as_array()?;
    let f = features.iter().find(|f| f.get("id").and_then(Value::as_str) == Some(feature_id))?;
    f.get("link")?.get("path")?.as_str().map(str::to_owned)
}

pub fn stale_count(s: &StaleLinks) -> usize {
    s.changed.len() + s.missing.len() + s.unknown.len()
}

/// The ones a refresh can read again: all but the missing.
pub fn refreshable(s: &StaleLinks) -> Vec<String> {
    s.changed.iter().chain(&s.unknown).cloned().collect()
}

pub fn stale_summary(s: &StaleLinks) -> String {
    let mut parts = Vec::new();
    let mut say = |n: usize, what: &str| {
        if n > 0 {
            parts.push(tr!("insert.stale.count", what = what, n = n));
        }
    };
    say(s.changed.len(), "changed");
    say(s.missing.len(), "missing");
    say(s.unknown.len(), "unknown");
    if parts.is_empty() {
        t("insert.stale.upToDate")
    } else {
        tr!("insert.stale.summary", list = parts.join(", "))
    }
}

/// What to tell the user of a failed insert, nothing for a cancel they asked for.
pub fn insert_error_text(e: &InsertError) -> Option<String> {
    match e {
        _ if e.cancelled() => None,
        InsertError::Read(why) => Some(tr!("insert.problem.read", error = why)),
        InsertError::Empty => Some(t("insert.problem.empty")),
        InsertError::Build(r) => Some(tr!("insert.problem.build", error = &r.message)),
        InsertError::ReadBack(r) => Some(tr!("insert.problem.readBack", error = &r.message)),
        InsertError::NotLinked => Some(t("insert.problem.notLinked")),
    }
}

pub fn written_summary(paths: &[String]) -> String {
    match paths {
        [] => t("export.wroteNothing"),
        [one] => tr!("export.wroteOne", name = files::base_name(one)),
        many => tr!("export.wroteMany", n = many.len(), dir = parent_of(&many[0])),
    }
}

fn parent_of(path: &str) -> &str {
    path.rfind(['/', '\\']).map_or(path, |i| &path[..i])
}

/// A Unix time as a calendar stamp, `offset_min` east of UTC.
#[cfg_attr(all(windows, not(test)), allow(dead_code, reason = "Windows reads the local time itself"))]
pub fn stamp_from_unix(secs: i64, offset_min: i64) -> Stamp {
    let t = secs + offset_min * 60;
    let (days, rem) = (t.div_euclid(86_400), t.rem_euclid(86_400));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = (yoe + era * 400 + i64::from(month <= 2)) as i32;
    Stamp { year, month, day, hour: (rem / 3600) as u32, minute: (rem % 3600 / 60) as u32, second: (rem % 60) as u32 }
}

#[cfg(windows)]
pub fn stamp_now() -> Stamp {
    // SAFETY: GetLocalTime only fills the struct it returns.
    let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    Stamp {
        year: i32::from(t.wYear),
        month: u32::from(t.wMonth),
        day: u32::from(t.wDay),
        hour: u32::from(t.wHour),
        minute: u32::from(t.wMinute),
        second: u32::from(t.wSecond),
    }
}

/// UTC, the app has no time zone source off Windows yet.
#[cfg(not(windows))]
pub fn stamp_now() -> Stamp {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
    stamp_from_unix(secs, 0)
}
