use semver::Version;

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

#[cfg(test)]
#[path = "update_channel_tests.rs"]
mod tests;
