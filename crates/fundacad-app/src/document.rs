//! What the shell shows of a document: its history and its parameters. The engine link fills it from a .funda;
//! until then `Document::sample` is the bracket the Vue workspace capture shows.

use gpui::SharedString;

/// The engine link reports the failed and warned steps.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Health {
    #[default]
    Ok,
    Warning,
    Error,
}

#[derive(Clone, Debug)]
pub struct Param {
    pub label: SharedString,
    pub value: f64,
    pub unit: &'static str,
    /// Set when the value is bound to an expression, shown in place of the number.
    pub expr: Option<SharedString>,
}

#[derive(Clone, Debug)]
pub struct Feature {
    /// The forge icon of the feature type.
    pub glyph: &'static str,
    pub name: SharedString,
    pub health: Health,
    pub suppressed: bool,
    pub params: Vec<Param>,
}

#[derive(Clone, Debug)]
pub struct Item {
    pub glyph: &'static str,
    pub name: SharedString,
    pub visible: bool,
}

#[derive(Clone, Debug)]
pub struct Group {
    pub glyph: &'static str,
    pub name: SharedString,
    pub items: Vec<Item>,
}

#[derive(Clone, Debug, Default)]
pub struct Document {
    pub name: SharedString,
    pub dirty: bool,
    pub features: Vec<Feature>,
    /// Features at and past this index are rolled back.
    pub marker: usize,
    pub groups: Vec<Group>,
}

impl Document {
    /// An opened file until the engine link reads its history: its name and nothing else.
    pub fn named(name: SharedString) -> Self {
        Self { name, ..Default::default() }
    }

    pub fn can_step_back(&self) -> bool {
        self.marker > 0
    }

    pub fn can_step_forward(&self) -> bool {
        self.marker < self.features.len()
    }

    pub fn set_marker(&mut self, at: usize) {
        self.marker = at.min(self.features.len());
    }

    pub fn sample() -> Self {
        let mm = |label: &str, value: f64| Param { label: label.to_string().into(), value, unit: "mm", expr: None };
        let sketch =
            |params| Feature { glyph: "sketch", name: "Sketch".into(), health: Health::Ok, suppressed: false, params };
        let extrude = |params| Feature {
            glyph: "extrude",
            name: "Extrude".into(),
            health: Health::Ok,
            suppressed: false,
            params,
        };
        let item = |glyph, name: &str, visible| Item { glyph, name: name.to_string().into(), visible };
        Self {
            name: "Untitled".into(),
            dirty: true,
            features: vec![
                sketch(vec![]),
                extrude(vec![mm("Distance", 10.)]),
                sketch(vec![]),
                extrude(vec![Param { label: "Distance".into(), value: 40., unit: "mm", expr: Some("height".into()) }]),
            ],
            marker: 4,
            groups: vec![
                Group {
                    glyph: "origin",
                    name: "Origin".into(),
                    items: vec![
                        item("plane", "XY plane", true),
                        item("plane", "XZ plane", true),
                        item("plane", "YZ plane", true),
                    ],
                },
                Group {
                    glyph: "body",
                    name: "Bodies".into(),
                    items: vec![item("body", "Body1", true), item("body", "Body2", true)],
                },
                Group {
                    glyph: "sketch",
                    name: "Sketches".into(),
                    items: vec![item("sketch", "Sketch1", false), item("sketch", "Sketch2", false)],
                },
            ],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Document;

    #[test]
    fn the_marker_stays_within_the_history() {
        let mut d = Document::sample();
        let n = d.features.len();
        assert!(d.can_step_back() && !d.can_step_forward());
        d.set_marker(n + 5);
        assert_eq!(d.marker, n);
        d.set_marker(0);
        assert!(!d.can_step_back() && d.can_step_forward());
        let empty = Document::named("bracket".into());
        assert!(!empty.can_step_back() && !empty.can_step_forward());
    }
}
