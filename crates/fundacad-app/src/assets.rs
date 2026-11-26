//! The app's own assets, served ahead of the kit's: the forge icon pack and the brand mark.

use std::borrow::Cow;

use gpui::{AssetSource, Result, SharedString};

#[derive(rust_embed::RustEmbed)]
#[folder = "assets"]
#[include = "icons/**/*.svg"]
#[include = "brand/*.svg"]
struct Own;

pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        match Own::get(path) {
            Some(file) => Ok(Some(file.data)),
            None => gpui_kit::assets::Assets.load(path),
        }
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut names: Vec<SharedString> = Own::iter().filter(|n| n.starts_with(path)).map(Into::into).collect();
        names.extend(gpui_kit::assets::Assets.list(path)?);
        Ok(names)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_our_icons_and_the_kits() {
        assert!(Assets.load("icons/forge/extrude.svg").unwrap().is_some());
        assert!(Assets.load("brand/fundacad-mark.svg").unwrap().is_some());
        assert!(!Assets.list("icons/forge/").unwrap().is_empty());
    }
}
