//! A stand-in until the tokens ported from the SCSS land (breadcrumb bezx1prt).

use gpui::{rgb, Rgba};

pub struct Theme {
    pub bg: Rgba,
    pub text: Rgba,
    pub text_dim: Rgba,
}

pub fn dark() -> Theme {
    Theme { bg: rgb(0x050409), text: rgb(0xf6f0e4), text_dim: rgb(0xc4bcd0) }
}
