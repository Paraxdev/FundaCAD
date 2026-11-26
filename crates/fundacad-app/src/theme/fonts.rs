//! Space Grotesk and JetBrains Mono, built into the binary. The ttf files are the @fontsource woff files the web
//! app ships, converted with fontTools, as DirectWrite does not load woff.

use std::borrow::Cow;

use gpui::App;

macro_rules! font {
    ($name:literal) => {
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/assets/fonts/", $name, ".ttf")).as_slice()
    };
}

const FONTS: &[&[u8]] = &[
    font!("space-grotesk-400"),
    font!("space-grotesk-500"),
    font!("space-grotesk-700"),
    font!("jetbrains-mono-400"),
    font!("jetbrains-mono-500"),
];

pub fn register(cx: &mut App) {
    cx.text_system().add_fonts(FONTS.iter().map(|f| Cow::Borrowed(*f)).collect()).expect("the bundled fonts load");
}
