//! FundaCAD.Screws: standard screws, bolts, nuts, washers and inserts. The engine's `fastener` shape generator, the
//! plugin's WebAssembly component, makes the solid once and it is stored as an `import` feature's blob, so a document
//! with fasteners builds where this plugin was never installed.

mod catalogue;

use fundacad_client::Doc;
use gpui::prelude::FluentBuilder as _;
use gpui::*;
use serde_json::{json, Map, Value};

use super::extra_params::pill;
use super::{MenuRow, Native};
use crate::commands::Group;
use crate::overlay::{self, Toast};
use crate::theme::{ActiveTheme as _, Theme, FS_BODY, FS_MICRO, FS_SMALL, R_MD, S_1, S_2, S_3, S_4, W_SEMIBOLD};
use crate::ui::{icon_button, solid_card, text};
use crate::viewport::Viewport;
use catalogue::ItemChoice;

pub const ID: &str = "FundaCAD.Screws";
const GENERATOR: &str = "fastener";

pub const NATIVE: Native =
    Native { manifest: include_str!("../../../../../plugins/FundaCAD.Screws/manifest.json"), install };

pub struct Library {
    viewport: Entity<Viewport>,
    open: bool,
    category: &'static str,
    choice: ItemChoice,
    /// A fastener of the document, shown by its body's Fastener Specs.
    document_spec: Option<Value>,
    busy: bool,
}

fn install(viewport: &Entity<Viewport>, _window: &mut Window, cx: &mut App) -> AnyView {
    let view = cx.new(|_| {
        let mut l = Library {
            viewport: viewport.clone(),
            open: std::env::var("FUNDA_PANEL").is_ok_and(|p| p == "fasteners"),
            category: catalogue::CATEGORY_ORDER[0],
            choice: ItemChoice::default(),
            document_spec: None,
            busy: false,
        };
        l.pick_category(catalogue::CATEGORY_ORDER[0]);
        l
    });
    let v = view.clone();
    super::command(cx, ID, "fasteners", "Fasteners", Group::Tools, move |_, cx| {
        v.update(cx, |l, cx| {
            l.open = !l.open;
            l.document_spec = None;
            cx.notify();
        })
    });
    let v = view.clone();
    super::add_body_menu(cx, ID, move |doc, owners, _| {
        let Some(spec) = spec_of(doc, owners) else { return Vec::new() };
        let v = v.clone();
        vec![MenuRow {
            label: "Fastener Specs\u{2026}".into(),
            run: std::rc::Rc::new(move |_, cx| {
                let spec = spec.clone();
                v.update(cx, |l, cx| {
                    (l.open, l.document_spec) = (true, Some(spec));
                    cx.notify();
                })
            }),
        }]
    });
    view.into()
}

/// The spec a body was generated from by this plugin, by the features that own its faces.
pub fn spec_of(doc: &Doc, owners: &[String]) -> Option<Value> {
    let features = doc.get("features")?.as_array()?;
    owners.iter().find_map(|o| {
        let f = features.iter().find(|f| f.get("id").and_then(Value::as_str) == Some(o.as_str()))?;
        let by = f.get("generatedBy").filter(|_| f.get("type").and_then(Value::as_str) == Some("import"))?;
        (by.get("plugin").and_then(Value::as_str) == Some(ID)).then(|| by.get("spec").cloned()).flatten()
    })
}

/// The `import` feature a generated shape becomes, as FundaCAD 1's insertFastener added it.
pub fn feature(id: &str, spec: &Value, reply: &Map<String, Value>) -> Result<Value, String> {
    let geom = reply.get("geom").filter(|g| !g.is_null()).ok_or("the generator made no geometry")?;
    Ok(json!({
        "id": id,
        "type": "import",
        "format": "brep",
        "name": spec.get("name").cloned().unwrap_or(json!("Fastener")),
        "geom": geom,
        "solid": reply.get("solid").cloned().unwrap_or(json!(true)),
        "generatedBy": {"plugin": ID, "spec": spec},
    }))
}

impl Library {
    fn pick_category(&mut self, category: &'static str) {
        self.category = category;
        if let Some(f) = catalogue::families().iter().find(|f| catalogue::category(f) == category) {
            self.pick_family(catalogue::family_id(f));
        }
    }

    fn pick_family(&mut self, id: &str) {
        let Some(f) = catalogue::family(id) else { return };
        let sizes = catalogue::sizes(f);
        // The size kept when the new family has it, so M5 stays M5 across families.
        let size = sizes.iter().find(|s| **s == self.choice.size).or(sizes.first()).map(|s| s.to_string());
        self.choice = ItemChoice { family: id.to_owned(), size: size.unwrap_or_default(), ..Default::default() };
        self.settle_length(None);
    }

    fn settle_length(&mut self, want: Option<f64>) {
        let Some(f) = catalogue::family(&self.choice.family) else { return };
        let ls = catalogue::lengths(f, &self.choice.size);
        let keep = want.or(self.choice.length).filter(|l| ls.iter().any(|x| (x - l).abs() < 1e-9));
        self.choice.length = keep.or_else(|| ls.get(ls.len() / 3).copied());
    }

    fn insert(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let spec = match catalogue::expand(&self.choice) {
            Ok(s) => s,
            Err(e) => return overlay::toast(cx, Toast::error(e)),
        };
        let Some(link) = self.viewport.read(cx).session_link(None) else {
            return overlay::toast(cx, Toast::error("Open a FundaCAD document first."));
        };
        self.busy = true;
        cx.notify();
        let name = spec.get("name").and_then(Value::as_str).unwrap_or("Fastener").to_owned();
        let mut fields = Map::new();
        fields.insert("generator".into(), json!(GENERATOR));
        fields.insert("params".into(), spec.clone());
        fields.insert("output".into(), json!("store"));
        cx.spawn_in(window, async move |this, cx| {
            let client = link.client.clone();
            let answer = cx.background_spawn(async move { client.request("generateShape", fields) }).await;
            let _ = this.update(cx, |l, cx| {
                l.busy = false;
                cx.notify();
                let reply = match answer {
                    Ok(r) => r,
                    Err(r) if r.cancelled => return,
                    Err(r) => {
                        return overlay::toast(cx, Toast::error(format!("{name} could not be made: {}", r.message)))
                    }
                };
                let added = l.viewport.update(cx, |v, cx| {
                    let id = v.doc().map(crate::tools::next_id).unwrap_or_else(|| "f1".into());
                    let f = feature(&id, &spec, &reply)?;
                    v.edit_step(None, Some(format!("Insert {name}")), move |d| crate::tools::insert(d, f.clone()), cx)
                });
                match added {
                    Ok(_) => overlay::toast(cx, Toast::info(format!("Inserted {name}."))),
                    Err(e) => overlay::toast(cx, Toast::error(format!("{name} could not be inserted: {e}"))),
                }
            });
        })
        .detach();
    }

    fn chips<T: Clone + PartialEq + 'static>(
        &self,
        t: &Theme,
        key: &str,
        items: Vec<(String, T)>,
        on: Option<T>,
        pick: fn(&mut Library, T),
        cx: &mut Context<Self>,
    ) -> Div {
        let mut row = div().flex().flex_wrap().gap(px(S_1));
        for (i, (label, v)) in items.into_iter().enumerate() {
            let selected = on.as_ref() == Some(&v);
            row = row.child(pill(t, SharedString::from(format!("{key}-{i}")), &label, selected).on_click(cx.listener(
                move |this, _, _, cx| {
                    pick(this, v.clone());
                    cx.notify();
                },
            )));
        }
        row
    }

    fn spec_lines(t: &Theme, spec: &Value) -> Div {
        let u = spec.get("units").and_then(Value::as_str).unwrap_or("mm");
        let n = |v: &Value| v.as_f64().map(|x| format!("{} {u}", catalogue::js_number((x * 1e3).round() / 1e3)));
        let mut lines = vec![
            ("Standard", spec.get("standard").and_then(Value::as_str).map(str::to_owned)),
            ("Type", spec.get("kind").and_then(Value::as_str).map(str::to_owned)),
            ("Thread", spec.pointer("/thread/designation").and_then(Value::as_str).map(str::to_owned)),
            ("Pitch", spec.pointer("/thread/pitch").and_then(n)),
            ("Length", spec.get("length").and_then(n)),
            ("Thread length", spec.pointer("/thread/length").and_then(n)),
        ];
        for part in ["head", "drive", "nut", "washer", "insert"] {
            if let Some(ty) = spec.pointer(&format!("/{part}/type")).and_then(Value::as_str) {
                lines.push(("Part", Some(format!("{part} {ty}"))));
            }
        }
        div().flex().flex_col().gap(px(2.)).children(lines.into_iter().filter_map(|(k, v)| {
            Some(
                div()
                    .flex()
                    .gap(px(S_3))
                    .child(text(t, FS_MICRO).w(px(96.)).text_color(t.text_mute).child(k))
                    .child(text(t, FS_SMALL).child(v?)),
            )
        }))
    }
}

impl Render for Library {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let _ = window;
        if !self.open || !super::enabled(cx, ID) {
            return div().into_any_element();
        }
        let t = cx.theme().clone();
        let t = &t;
        let head = div()
            .flex()
            .items_center()
            .justify_between()
            .child(text(t, FS_BODY).font_weight(W_SEMIBOLD).text_color(t.accent_hot).child("Fasteners"))
            .child(icon_button(t, "fasteners-close", "close", 28., 14., t.text_mute).on_click(cx.listener(
                |this, _, _, cx| {
                    this.open = false;
                    cx.notify();
                },
            )));
        let mut body = div().id("fasteners-body").flex().flex_col().gap(px(S_2)).min_h_0().overflow_y_scroll();
        if let Some(spec) = &self.document_spec {
            let name = spec.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
            body = body
                .child(text(t, FS_SMALL).font_weight(W_SEMIBOLD).child(name))
                .child(Self::spec_lines(t, spec))
                .child(pill(t, "fasteners-back", "Catalogue", false).on_click(cx.listener(|this, _, _, cx| {
                    this.document_spec = None;
                    cx.notify();
                })));
        } else {
            let present: Vec<(String, &'static str)> = catalogue::CATEGORY_ORDER
                .into_iter()
                .filter(|c| catalogue::families().iter().any(|f| catalogue::category(f) == *c))
                .map(|c| (c.to_owned(), c))
                .collect();
            body = body.child(self.chips(t, "cat", present, Some(self.category), |l, c| l.pick_category(c), cx));
            let fams: Vec<(String, String)> = catalogue::families()
                .iter()
                .filter(|f| catalogue::category(f) == self.category)
                .map(|f| (format!("{} {}", catalogue::standard(f), catalogue::name(f)), catalogue::family_id(f).to_owned()))
                .collect();
            body = body.child(self.chips(t, "fam", fams, Some(self.choice.family.clone()), |l, id| l.pick_family(&id), cx));
            if let Some(f) = catalogue::family(&self.choice.family) {
                let sizes: Vec<(String, String)> =
                    catalogue::sizes(f).into_iter().map(|s| (s.to_owned(), s.to_owned())).collect();
                body = body.child(self.chips(
                    t,
                    "size",
                    sizes,
                    Some(self.choice.size.clone()),
                    |l, s| {
                        l.choice.size = s;
                        l.choice.pitch = None;
                        l.settle_length(None);
                    },
                    cx,
                ));
                let inch = catalogue::units(f) == "in";
                let lengths: Vec<(String, u64)> = catalogue::lengths(f, &self.choice.size)
                    .into_iter()
                    .map(|l| {
                        let label = if inch { format!("{}\"", catalogue::format_inch(l)) } else { catalogue::js_number(l) };
                        (label, l.to_bits())
                    })
                    .collect();
                if !lengths.is_empty() {
                    body = body.child(text(t, FS_MICRO).text_color(t.text_mute).child("Length")).child(self.chips(
                        t,
                        "len",
                        lengths,
                        self.choice.length.map(f64::to_bits),
                        |l, bits| l.settle_length(Some(f64::from_bits(bits))),
                        cx,
                    ));
                }
                let drives = catalogue::drives(f);
                if drives.len() > 1 {
                    let items = drives.iter().map(|d| (d.clone(), d.clone())).collect();
                    let on = self.choice.drive.clone().or(drives.first().cloned());
                    body = body.child(self.chips(t, "drive", items, on, |l, d| l.choice.drive = Some(d), cx));
                }
                let pitches = catalogue::pitches(f, &self.choice.size);
                if pitches.len() > 1 {
                    let items = pitches
                        .iter()
                        .map(|p| (catalogue::designation(f, &self.choice.size, *p), p.to_bits()))
                        .collect();
                    let on = self.choice.pitch.or(pitches.first().copied()).map(f64::to_bits);
                    body = body.child(self.chips(t, "pitch", items, on, |l, p| l.choice.pitch = Some(f64::from_bits(p)), cx));
                }
                let thread = vec![("Plain".to_owned(), false), ("Modelled thread".to_owned(), true)];
                body = body.child(self.chips(t, "thread", thread, Some(self.choice.modelled), |l, m| l.choice.modelled = m, cx));
            }
            match catalogue::expand(&self.choice) {
                Ok(spec) => {
                    let name = spec.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
                    let busy = self.busy;
                    body = body
                        .child(text(t, FS_SMALL).font_weight(W_SEMIBOLD).mt(px(S_2)).child(name))
                        .child(Self::spec_lines(t, &spec))
                        .child(
                            text(t, FS_SMALL)
                                .id("fasteners-insert")
                                .mt(px(S_2))
                                .h(px(28.))
                                .px(px(S_3))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(R_MD))
                                .bg(if busy { t.raised } else { t.accent })
                                .text_color(if busy { t.text_dim } else { t.on_accent })
                                .child(if busy { "Inserting\u{2026}" } else { "Insert into the model" })
                                .when(!busy, |d| d.on_click(cx.listener(|this, _, w, cx| this.insert(w, cx)))),
                        );
                }
                Err(e) => body = body.child(text(t, FS_SMALL).text_color(t.error).child(e)),
            }
        }
        div()
            .absolute()
            .top(px(56.))
            .right(px(360.))
            .bottom(px(56.))
            .w(px(400.))
            .flex()
            .flex_col()
            .child(solid_card(t).max_h_full().min_h_0().p(px(S_4)).gap(px(S_2)).child(head).child(body))
            .into_any_element()
    }
}
