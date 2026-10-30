use semver::Version;
use serde::Serialize;
use tauri::{Manager, Runtime, Webview};
use tauri_plugin_updater::{RemoteRelease, Updater, UpdaterExt};
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
pub fn plan(build: Channel, picked: Channel) -> Result<Plan, String> {
    if build.product() != picked.product() {
        return Err(format!("the {} channel is another product, install it beside this app", picked.as_str()));
    }
    Ok(Plan { endpoint: picked.endpoint(), allow_downgrade: picked != build })
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

fn updater_for<R: Runtime>(
    webview: &Webview<R>,
    endpoint: &str,
    comparator: impl Fn(Version, RemoteRelease) -> bool + Send + Sync + 'static,
) -> Result<Updater, String> {
    let url = Url::parse(endpoint).map_err(|e| e.to_string())?;
    webview
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .version_comparator(comparator)
        .build()
        .map_err(|e| e.to_string())
}

// Any stable latest.json that parses means a stable release exists, the comparator keeps the probe from offering it.
async fn stable_feed_exists<R: Runtime>(webview: &Webview<R>) -> bool {
    match updater_for(webview, Channel::Stable.endpoint(), |_, _| false) {
        Ok(updater) => updater.check().await.is_ok(),
        Err(_) => false,
    }
}

/// Checks the picked channel's feed, building the updater per check because the plugin's own check cannot change
/// endpoints. `stable` says whether a stable release exists, so the picker can offer it.
#[tauri::command]
pub async fn update_check<R: Runtime>(webview: Webview<R>, channel: String) -> Result<ChannelCheck, String> {
    let picked = Channel::parse(&channel).ok_or_else(|| format!("unknown update channel {channel}"))?;
    let build = build_channel(webview.config().plugins.0.get("updater"))
        .ok_or_else(|| "this build has no known update channel".to_string())?;
    let plan = plan(build, picked)?;
    let allow_downgrade = plan.allow_downgrade;
    let found = updater_for(&webview, plan.endpoint, move |current, release| {
        accepts(&current, &release.version, allow_downgrade)
    })?
    .check()
    .await
    .map_err(|e| e.to_string())?;
    let stable = picked == Channel::Stable || stable_feed_exists(&webview).await;
    let update = found.map(|update| {
        let downgrade = match (Version::parse(&update.current_version), Version::parse(&update.version)) {
            (Ok(current), Ok(remote)) => is_downgrade(&current, &remote),
            _ => false,
        };
        ChannelUpdate {
            current_version: update.current_version.clone(),
            version: update.version.clone(),
            date: update.raw_json.get("pub_date").and_then(|d| d.as_str()).map(str::to_owned),
            body: update.body.clone(),
            raw_json: update.raw_json.clone(),
            downgrade,
            rid: webview.resources_table().add(update),
        }
    });
    Ok(ChannelCheck { update, stable })
}

#[cfg(test)]
#[path = "update_channel_tests.rs"]
mod tests;
