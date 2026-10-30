use semver::Version;
use serde::Serialize;
use tauri::{Manager, Runtime, Webview};
use tauri_plugin_updater::{RemoteRelease, Updater, UpdaterExt};
use time::format_description::well_known::Rfc3339;
use url::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    Stable,
    Beta,
    Development,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Product {
    FundaCad,
    FundaCadDev,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    pub endpoint: &'static str,
    pub allow_downgrade: bool,
    /// The stable feed, looked at beside the picked one until a stable release was seen.
    pub probe: Option<&'static str>,
}

const ALL: [Channel; 3] = [Channel::Stable, Channel::Beta, Channel::Development];

impl Channel {
    pub fn parse(name: &str) -> Option<Channel> {
        ALL.into_iter().find(|ch| ch.as_str() == name)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Beta => "beta",
            Channel::Development => "development",
        }
    }

    // Must match plugins.updater.endpoints in tauri.stable.conf.json, tauri.conf.json and tauri.dev.conf.json.
    pub fn endpoint(self) -> &'static str {
        match self {
            Channel::Stable => "https://github.com/Paraxdev/fundacad/releases/latest/download/latest.json",
            Channel::Beta => "https://github.com/Paraxdev/fundacad/releases/download/beta/latest.json",
            Channel::Development => "https://github.com/Paraxdev/fundacad/releases/download/development/latest.json",
        }
    }

    pub fn from_endpoint(url: &str) -> Option<Channel> {
        ALL.into_iter().find(|ch| ch.endpoint() == url)
    }

    pub fn product(self) -> Product {
        match self {
            Channel::Stable | Channel::Beta => Product::FundaCad,
            Channel::Development => Product::FundaCadDev,
        }
    }
}

/// Where the next check looks and whether it may offer an older version. A channel of the other product is an Err:
/// FundaCAD Dev installs beside FundaCAD and never replaces it.
pub fn plan(build: Channel, picked: Channel, stable_seen: bool) -> Result<Plan, String> {
    if build.product() != picked.product() {
        return Err(format!("the {} channel is another product, install it beside this app", picked.as_str()));
    }
    let probe = (picked != Channel::Stable && !stable_seen).then(|| Channel::Stable.endpoint());
    Ok(Plan { endpoint: picked.endpoint(), allow_downgrade: picked != build, probe })
}

pub fn accepts(current: &Version, remote: &Version, allow_downgrade: bool) -> bool {
    if allow_downgrade {
        remote != current
    } else {
        remote > current
    }
}

pub fn is_downgrade(current: &Version, remote: &Version) -> bool {
    remote < current
}

/// The channel this build updates from, read back from the first endpoint of its plugins.updater config.
pub fn build_channel(updater_config: Option<&serde_json::Value>) -> Option<Channel> {
    let first = updater_config?.get("endpoints")?.get(0)?.as_str()?;
    Channel::from_endpoint(first)
}

/// The updater plugin's own check metadata, so the frontend Update class downloads and installs it by rid.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelUpdate {
    rid: tauri::ResourceId,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
    downgrade: bool,
}

#[derive(Serialize)]
pub struct ChannelCheck {
    update: Option<ChannelUpdate>,
    stable: bool,
}

fn updater_for<R: Runtime, M: Manager<R>>(
    app: &M,
    endpoint: &str,
    comparator: impl Fn(Version, RemoteRelease) -> bool + Send + Sync + 'static,
) -> Result<Updater, String> {
    let url = Url::parse(endpoint).map_err(|e| e.to_string())?;
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .version_comparator(comparator)
        .build()
        .map_err(|e| e.to_string())
}

fn own_channel<R: Runtime>(webview: &Webview<R>) -> Option<Channel> {
    build_channel(webview.config().plugins.0.get("updater"))
}

/// Checks `endpoint`, and `probe` beside it when given: any latest.json there that parses means a stable release
/// exists, and its comparator keeps the probe from offering it. `stable` is true when there is nothing to probe.
async fn check_feeds<R: Runtime, M: Manager<R>>(
    app: &M,
    endpoint: &str,
    allow_downgrade: bool,
    probe: Option<String>,
) -> Result<ChannelCheck, String> {
    let updater =
        updater_for(app, endpoint, move |current, release| accepts(&current, &release.version, allow_downgrade))?;
    let probe = probe.map(|url| {
        let prober = updater_for(app, &url, |_, _| false);
        tauri::async_runtime::spawn(async move {
            match prober {
                Ok(prober) => prober.check().await.is_ok(),
                Err(_) => false,
            }
        })
    });
    let found = updater.check().await.map_err(|e| e.to_string())?;
    let stable = match probe {
        Some(task) => task.await.unwrap_or(false),
        None => true,
    };
    let update = found.map(|update| {
        let downgrade = match (Version::parse(&update.current_version), Version::parse(&update.version)) {
            (Ok(current), Ok(remote)) => is_downgrade(&current, &remote),
            _ => false,
        };
        ChannelUpdate {
            current_version: update.current_version.clone(),
            version: update.version.clone(),
            date: update.date.and_then(|d| d.format(&Rfc3339).ok()),
            body: update.body.clone(),
            raw_json: update.raw_json.clone(),
            downgrade,
            rid: app.resources_table().add(update),
        }
    });
    Ok(ChannelCheck { update, stable })
}

/// Checks the picked channel's feed, building the updater per check because the plugin's own check cannot change
/// endpoints. `stable` says whether a stable release exists, so the picker can offer it.
#[tauri::command]
pub async fn update_check<R: Runtime>(
    webview: Webview<R>,
    channel: String,
    stable_seen: bool,
) -> Result<ChannelCheck, String> {
    let picked = Channel::parse(&channel).ok_or_else(|| format!("unknown update channel {channel}"))?;
    let build = own_channel(&webview).ok_or_else(|| "this build has no known update channel".to_string())?;
    let plan = plan(build, picked, stable_seen)?;
    check_feeds(&webview, plan.endpoint, plan.allow_downgrade, plan.probe.map(str::to_owned)).await
}

/// The frontend's own idea of the build channel comes from VITE_FUNDACAD_RELEASE, which a local build may lack.
#[tauri::command]
pub fn update_build_channel<R: Runtime>(webview: Webview<R>) -> Option<&'static str> {
    own_channel(&webview).map(Channel::as_str)
}

#[cfg(test)]
#[path = "update_channel_tests.rs"]
mod tests;
