//! The update check, FundaCAD 1's stable channel: the latest GitHub release's latest.json, newer when its version is
//! above this build's by semver. It only tells, the download page installs.

#[cfg(test)]
mod tests;

use std::cmp::Ordering;

pub const FEED: &str = "https://github.com/Paraxdev/fundacad/releases/latest/download/latest.json";
pub const DOWNLOAD_URL: &str = "https://fundacad.dev/download/";
/// FundaCAD 1's fundacad.updates.auto, false turns the check at launch off.
pub const SETTING: &str = "updates.auto";
/// A local latest.json read in place of the feed, for tests and screenshots.
pub const FEED_ENV: &str = "FUNDA_UPDATE_FEED";

#[derive(Debug, PartialEq, Eq)]
struct Version<'a> {
    core: [u64; 3],
    pre: Vec<&'a str>,
}

fn parse(v: &str) -> Option<Version<'_>> {
    let v = v.trim().trim_start_matches('v');
    let v = v.split('+').next()?;
    let (core, pre) = v.split_once('-').map_or((v, None), |(c, p)| (c, Some(p)));
    let mut nums = core.split('.').map(|n| n.parse::<u64>().ok());
    let core = [nums.next()??, nums.next()??, nums.next()??];
    if nums.next().is_some() {
        return None;
    }
    let pre = pre.map_or_else(Vec::new, |p| p.split('.').collect());
    if pre.iter().any(|p| p.is_empty()) {
        return None;
    }
    Some(Version { core, pre })
}

fn cmp_ident(a: &str, b: &str) -> Ordering {
    match (a.parse::<u64>(), b.parse::<u64>()) {
        (Ok(x), Ok(y)) => x.cmp(&y),
        (Ok(_), Err(_)) => Ordering::Less,
        (Err(_), Ok(_)) => Ordering::Greater,
        _ => a.cmp(b),
    }
}

/// Semver precedence, None when either is not a version.
pub fn compare(a: &str, b: &str) -> Option<Ordering> {
    let (a, b) = (parse(a)?, parse(b)?);
    let by_core = a.core.cmp(&b.core);
    if by_core != Ordering::Equal {
        return Some(by_core);
    }
    Some(match (a.pre.is_empty(), b.pre.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        _ => {
            for (x, y) in a.pre.iter().zip(&b.pre) {
                let o = cmp_ident(x, y);
                if o != Ordering::Equal {
                    return Some(o);
                }
            }
            a.pre.len().cmp(&b.pre.len())
        }
    })
}

#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Newer(String),
    UpToDate,
    NoRelease,
    Offline(String),
    Failed(String),
}

impl Outcome {
    pub fn message(&self, current: &str) -> String {
        match self {
            Outcome::Newer(v) => format!("FundaCAD {v} is out, this is {current}"),
            Outcome::UpToDate => format!("FundaCAD {current} is the latest version"),
            Outcome::NoRelease => "There is no FundaCAD release to check against yet".into(),
            Outcome::Offline(why) => format!("Could not reach GitHub to check for updates, {why}"),
            Outcome::Failed(why) => format!("The update check failed, {why}"),
        }
    }
}

/// What a fetch of the feed means. `status` is None when no answer came back.
pub fn judge(current: &str, status: Option<u16>, body: &str, transport: &str) -> Outcome {
    match status {
        None => Outcome::Offline(if transport.is_empty() { "no answer".into() } else { transport.to_string() }),
        Some(404) => Outcome::NoRelease,
        Some(200) => {
            let Some(version) = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|v| v.get("version")?.as_str().map(str::to_string))
            else {
                return Outcome::Failed("the release has no readable latest.json".into());
            };
            match compare(&version, current) {
                Some(Ordering::Greater) => Outcome::Newer(version.trim_start_matches('v').to_string()),
                Some(_) => Outcome::UpToDate,
                None => Outcome::Failed(format!("{version} is not a version")),
            }
        }
        Some(code) => Outcome::Failed(format!("GitHub answered {code}")),
    }
}

/// curl ships with Windows 10 and later, macOS and the Linux desktops, so the app needs no TLS stack of its own.
fn fetch(url: &str) -> (Option<u16>, String, String) {
    let mut cmd = std::process::Command::new("curl");
    cmd.args(["-sSL", "--max-time", "15", "-H", "Accept: application/json", "-w", "\n%{http_code}", url]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.output() {
        Err(e) => (None, String::new(), format!("curl could not run: {e}")),
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            let (body, code) = text.rsplit_once('\n').unwrap_or(("", &text));
            let status = code.trim().parse::<u16>().ok().filter(|c| *c != 0);
            let err = String::from_utf8_lossy(&out.stderr).trim().trim_start_matches("curl: ").to_string();
            (status, body.to_string(), err)
        }
    }
}

/// Blocks, so it runs on a background thread.
pub fn check(current: &str) -> Outcome {
    if let Some(path) = std::env::var_os(FEED_ENV) {
        return match std::fs::read_to_string(&path) {
            Ok(body) => judge(current, Some(200), &body, ""),
            Err(_) => judge(current, Some(404), "", ""),
        };
    }
    let (status, body, err) = fetch(FEED);
    judge(current, status, &body, &err)
}
