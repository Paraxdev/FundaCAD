use gpui::{Fill, Hsla, Rgba};

/// An sRGB colour with straight alpha, all channels 0 to 1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgb {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Rgb {
    pub const TRANSPARENT: Rgb = Rgb { r: 0., g: 0., b: 0., a: 0. };
    pub const WHITE: Rgb = Rgb::hex(0xffffff);
    pub const BLACK: Rgb = Rgb::hex(0x000000);

    pub const fn hex(v: u32) -> Self {
        Self {
            r: ((v >> 16) & 0xff) as f32 / 255.,
            g: ((v >> 8) & 0xff) as f32 / 255.,
            b: (v & 0xff) as f32 / 255.,
            a: 1.,
        }
    }

    pub const fn rgba(r: u8, g: u8, b: u8, a: f32) -> Self {
        Self { r: r as f32 / 255., g: g as f32 / 255., b: b as f32 / 255., a }
    }

    pub fn alpha(self, a: f32) -> Self {
        Self { a: self.a * a, ..self }
    }

    /// `color-mix(in srgb, self p, other)`. CSS mixes premultiplied, so a transparent side only lowers the alpha.
    pub fn mix(self, p: f32, other: Rgb) -> Self {
        let (a1, a2) = (self.a * p, other.a * (1. - p));
        let a = a1 + a2;
        if a == 0. {
            return Self::TRANSPARENT;
        }
        let ch = |x: f32, y: f32| (x * a1 + y * a2) / a;
        Self { r: ch(self.r, other.r), g: ch(self.g, other.g), b: ch(self.b, other.b), a }
    }

    /// `color-mix(in srgb, self p, transparent)`.
    pub fn fade(self, p: f32) -> Self {
        self.mix(p, Self::TRANSPARENT)
    }

    /// The forms an uploaded palette may use: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, and `rgb()` or `rgba()` with
    /// commas or spaces, channels as numbers or percentages, alpha as a number or a percentage after a comma or `/`.
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim().to_ascii_lowercase();
        if let Some(h) = s.strip_prefix('#') {
            return Self::parse_hex(h);
        }
        let inner = s.strip_prefix("rgba(").or_else(|| s.strip_prefix("rgb("))?.strip_suffix(')')?;
        let (chans, alpha) = match inner.split_once('/') {
            Some((c, a)) => (c, Some(a.trim())),
            None => (inner, None),
        };
        let mut parts: Vec<&str> = chans.split([',', ' ']).map(str::trim).filter(|p| !p.is_empty()).collect();
        let alpha = match (alpha, parts.len()) {
            (Some(a), 3) => Some(a),
            (None, 4) => parts.pop(),
            (None, 3) => None,
            _ => return None,
        };
        let chan = |p: &str| -> Option<f32> {
            let v = match p.strip_suffix('%') {
                Some(n) => n.parse::<f32>().ok()? / 100.,
                None => p.parse::<f32>().ok()? / 255.,
            };
            v.is_finite().then_some(v.clamp(0., 1.))
        };
        let a = match alpha {
            Some(p) => {
                let v = match p.strip_suffix('%') {
                    Some(n) => n.parse::<f32>().ok()? / 100.,
                    None => p.parse::<f32>().ok()?,
                };
                if !v.is_finite() {
                    return None;
                }
                v.clamp(0., 1.)
            }
            None => 1.,
        };
        Some(Self { r: chan(parts[0])?, g: chan(parts[1])?, b: chan(parts[2])?, a })
    }

    fn parse_hex(h: &str) -> Option<Self> {
        if !h.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let nib = |i: usize| u8::from_str_radix(&h[i..i + 1], 16).ok().map(|v| v * 17);
        let byte = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
        let (r, g, b, a) = match h.len() {
            3 => (nib(0)?, nib(1)?, nib(2)?, 255),
            4 => (nib(0)?, nib(1)?, nib(2)?, nib(3)?),
            6 => (byte(0)?, byte(2)?, byte(4)?, 255),
            8 => (byte(0)?, byte(2)?, byte(4)?, byte(6)?),
            _ => return None,
        };
        Some(Self::rgba(r, g, b, a as f32 / 255.))
    }

    /// WCAG relative luminance, alpha ignored.
    pub fn luminance(self) -> f32 {
        let lin = |c: f32| if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) };
        0.2126 * lin(self.r) + 0.7152 * lin(self.g) + 0.0722 * lin(self.b)
    }

    /// WCAG contrast ratio of two opaque colours.
    pub fn contrast(self, other: Rgb) -> f32 {
        let (a, b) = (self.luminance(), other.luminance());
        (a.max(b) + 0.05) / (a.min(b) + 0.05)
    }

    /// This colour painted over an opaque one.
    pub fn over(self, base: Rgb) -> Rgb {
        let a = self.a;
        Rgb {
            r: self.r * a + base.r * (1. - a),
            g: self.g * a + base.g * (1. - a),
            b: self.b * a + base.b * (1. - a),
            a: 1.,
        }
    }
}

impl From<Rgb> for Rgba {
    fn from(c: Rgb) -> Self {
        Rgba { r: c.r, g: c.g, b: c.b, a: c.a }
    }
}

impl From<Rgb> for Hsla {
    fn from(c: Rgb) -> Self {
        Rgba::from(c).into()
    }
}

impl From<Rgb> for Fill {
    fn from(c: Rgb) -> Self {
        Hsla::from(c).into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: Rgb, b: Rgb) -> bool {
        [(a.r, b.r), (a.g, b.g), (a.b, b.b), (a.a, b.a)].iter().all(|(x, y)| (x - y).abs() < 0.002)
    }

    #[test]
    fn parses_the_upload_forms() {
        let want = Rgb::rgba(154, 159, 240, 0.14);
        for s in
            ["rgba(154, 159, 240, 0.14)", "rgb(154 159 240 / 14%)", "RGBA(154,159,240,.14)", "rgb(154, 159, 240, 0.14)"]
        {
            assert!(close(Rgb::parse(s).unwrap(), want), "{s}");
        }
        assert!(close(Rgb::parse("#9a9ff0").unwrap(), Rgb::hex(0x9a9ff0)));
        assert!(close(Rgb::parse("#fff").unwrap(), Rgb::WHITE));
        assert!(close(Rgb::parse("#0000").unwrap(), Rgb::TRANSPARENT));
        assert!(close(Rgb::parse("#9a9ff080").unwrap(), Rgb::hex(0x9a9ff0).alpha(128. / 255.)));
        for bad in
            ["", "#12", "#ggg", "red", "rgb(1,2)", "rgb(1,2,3,4,5)", "rgba(1,2,3", "rgb(a,b,c)", "rgb(1,2,3/4,5)"]
        {
            assert!(Rgb::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn mix_matches_css() {
        // color-mix(in srgb, #1b1826 72%, transparent) keeps the colour and scales the alpha.
        let m = Rgb::hex(0x1b1826).fade(0.72);
        assert!(close(m, Rgb::hex(0x1b1826).alpha(0.72)));
        // Two opaque colours mix channel by channel.
        let m = Rgb::WHITE.mix(0.7, Rgb::hex(0xf5f3f9));
        assert!(close(
            m,
            Rgb {
                r: (0.7 * 255. + 0.3 * 245.) / 255.,
                g: (0.7 * 255. + 0.3 * 243.) / 255.,
                b: (0.7 * 255. + 0.3 * 249.) / 255.,
                a: 1.
            }
        ));
    }

    #[test]
    fn contrast_is_wcag() {
        assert!((Rgb::WHITE.contrast(Rgb::BLACK) - 21.).abs() < 0.01);
        assert!((Rgb::hex(0x777777).contrast(Rgb::WHITE) - 4.48).abs() < 0.01);
    }
}
