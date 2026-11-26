//! A panic writes `crash.txt` next to the log. The next start moves it to `crash.old.txt` and offers it in the problem
//! report, so one crash is offered once.

#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const NAME: &str = "crash.txt";
pub const OLD: &str = "crash.old.txt";

/// `2026-11-26 18:42:07 UTC` from seconds since 1970.
pub fn utc_stamp(secs: u64) -> String {
    let (days, rest) = ((secs / 86_400) as i64, secs % 86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02} UTC", rest / 3600, rest % 3600 / 60, rest % 60)
}

pub fn now_stamp() -> String {
    utc_stamp(SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()))
}

pub fn crash_text(stamp: &str, thread: &str, message: &str, location: &str, backtrace: &str) -> String {
    format!(
        "FundaCAD {} crashed at {stamp}\nthread '{thread}' panicked at {location}:\n{message}\n\nbacktrace:\n{backtrace}\n",
        env!("CARGO_PKG_VERSION")
    )
}

fn payload_text(info: &std::panic::PanicHookInfo) -> String {
    let p = info.payload();
    p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_default()
}

/// Chained before the default hook, which still prints to stderr.
pub fn install(dir: Option<PathBuf>) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info.location().map_or_else(String::new, |l| format!("{}:{}", l.file(), l.line()));
        let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        let text = crash_text(&now_stamp(), &thread, &payload_text(info), &location, &backtrace);
        log::error!("panic in '{thread}' at {location}: {}", payload_text(info));
        if let Some(dir) = &dir {
            let _ = std::fs::create_dir_all(dir);
            let _ = std::fs::write(dir.join(NAME), &text);
        }
        previous(info);
    }));
}

/// The last run's crash, moved aside so it is offered once.
pub fn take_pending(dir: &Path) -> Option<String> {
    let path = dir.join(NAME);
    let text = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::rename(&path, dir.join(OLD));
    (!text.trim().is_empty()).then_some(text)
}
