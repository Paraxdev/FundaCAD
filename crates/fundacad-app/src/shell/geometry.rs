//! The Geometry tab: one body's faces and edges, or the document's planes, as a filtered, paged list.

use std::rc::Rc;
use std::sync::Arc;

use fundacad_client::{Body, Doc};
use gpui::prelude::FluentBuilder as _;
use gpui::*;

use super::items::{menu_row, picker, popup};
use super::Shell;
use crate::i18n;
use crate::items::geometry::{self as geo, Facing, Filters, GeomKind, GeomRow, RowType, PAGE_SIZE};
use crate::items::{self, features, str_of};
use crate::theme::{Theme, FLOAT_CHIP_RADIUS, FS_BODY, FS_MICRO, FS_SMALL, R_PILL, S_1, S_2, W_SEMIBOLD};
use crate::ui::text;

#[derive(Clone, Copy)]
pub(super) enum GeoMenu {
    Body,
    Type,
    Facing,
}

#[derive(Default)]
pub(super) struct GeoState {
    kind: GeomKind,
    filters: Filters,
    body: Option<String>,
    page: usize,
    selected: Option<String>,
    pub(super) menu: Option<(GeoMenu, Point<Pixels>)>,
    /// Face and edge rows of the last body read, by its mesh, so a redraw does not walk every triangle again.
    cache: Option<(Arc<Body>, GeomKind, Rc<Vec<GeomRow>>)>,
}

/// What a feature id reads as in a face hint: its own name, else its type with a capital.
fn feature_names(doc: &Doc) -> std::collections::HashMap<String, String> {
    features(doc)
        .filter_map(|f| {
            let id = str_of(f, "id")?;
            let name = str_of(f, "name").map(str::to_string).or_else(|| {
                let ty = str_of(f, "type")?;
                let mut c = ty.chars();
                Some(c.next()?.to_uppercase().chain(c).collect())
            })?;
            Some((id.to_string(), name))
        })
        .collect()
}

impl Shell {
    fn geo_rows(&mut self, body: Option<&Arc<Body>>) -> Rc<Vec<GeomRow>> {
        let empty = Doc::new();
        let doc = self.source.as_ref().unwrap_or(&empty);
        let kind = self.items.geo.kind;
        if kind == GeomKind::Planes {
            return Rc::new(geo::plane_rows(doc));
        }
        let Some(body) = body else { return Rc::new(Vec::new()) };
        if let Some((b, k, rows)) = &self.items.geo.cache {
            if Arc::ptr_eq(b, body) && *k == kind {
                return rows.clone();
            }
        }
        let rows = Rc::new(match kind {
            GeomKind::Edges => geo::edge_rows(body),
            _ => {
                let names = feature_names(doc);
                geo::face_rows(body, |id| names.get(id).cloned())
            }
        });
        self.items.geo.cache = Some((body.clone(), kind, rows.clone()));
        rows
    }

    fn geo_menu(&self, t: &Theme, labels: &[(String, String)], cx: &mut Context<Self>) -> Option<AnyElement> {
        let (which, pos) = self.items.geo.menu?;
        let g = &self.items.geo;
        let mut rows: Vec<AnyElement> = Vec::new();
        let mut row = |i: usize, label: String, on: bool, pick: Box<dyn Fn(&mut GeoState)>| {
            rows.push(
                menu_row(t, ("geo-menu", i), label, on)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        pick(&mut this.items.geo);
                        this.items.geo.menu = None;
                        this.items.geo.page = 0;
                        cx.notify();
                    }))
                    .into_any_element(),
            );
        };
        match which {
            GeoMenu::Body => {
                for (i, (id, label)) in labels.iter().enumerate() {
                    let pick = id.clone();
                    let on = g.body.as_deref() == Some(id);
                    row(i, label.clone(), on, Box::new(move |g| g.body = Some(pick.clone())));
                }
            }
            GeoMenu::Type => {
                row(
                    0,
                    i18n::t("geometry.list.any"),
                    g.filters.row_type.is_none(),
                    Box::new(|g| g.filters.row_type = None),
                );
                for (i, ty) in g.kind.types().iter().copied().enumerate() {
                    let on = g.filters.row_type == Some(ty);
                    row(i + 1, ty.label(), on, Box::new(move |g| g.filters.row_type = Some(ty)));
                }
            }
            GeoMenu::Facing => {
                row(0, i18n::t("geometry.list.any"), g.filters.facing.is_none(), Box::new(|g| g.filters.facing = None));
                for (i, w) in geo::FACINGS.iter().copied().enumerate() {
                    let on = g.filters.facing == Some(w);
                    row(i + 1, w.label(), on, Box::new(move |g| g.filters.facing = Some(w)));
                }
            }
        }
        let close = cx.listener(|this, _: &MouseDownEvent, _, cx| {
            this.items.geo.menu = None;
            cx.notify();
        });
        Some(popup(t, pos, close, rows).into_any_element())
    }

    pub(super) fn geometry_tab(&mut self, t: &Theme, _window: &mut Window, cx: &mut Context<Self>) -> Div {
        let shown = self.viewport.read(cx).shown_bodies();
        let empty = Doc::new();
        let doc = self.source.as_ref().unwrap_or(&empty);
        let refs: Vec<items::BodyRef> = shown.iter().map(|b| items::BodyRef::of(b)).collect();
        let names = items::body_labels(&refs, |id| items::user_body_name(doc, id));
        let labels: Vec<(String, String)> =
            refs.iter().map(|b| (b.id.clone(), names.get(&b.id).cloned().unwrap_or_else(|| b.name.clone()))).collect();
        if !shown.iter().any(|b| Some(&b.id) == self.items.geo.body.as_ref()) {
            self.items.geo.body = shown.first().map(|b| b.id.clone());
        }
        let body = shown.iter().find(|b| Some(&b.id) == self.items.geo.body.as_ref()).cloned();
        let rows = self.geo_rows(body.as_ref());
        let g = &self.items.geo;
        let kind = g.kind;
        let filtered = geo::filter_rows(&rows, &g.filters);
        let pages = geo::page_count(filtered.len());
        let page = g.page.min(pages - 1);

        let raised = t.raised;
        let segment = div()
            .mx(px(14.))
            .mt(px(S_2))
            .p(px(2.))
            .flex()
            .gap(px(2.))
            .rounded(px(FLOAT_CHIP_RADIUS))
            .bg(t.field_bg)
            .children(geo::KINDS.iter().copied().map(|k| {
                let on = k == kind;
                text(t, FS_SMALL)
                    .id(k.id())
                    .flex_1()
                    .h(px(26.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(FLOAT_CHIP_RADIUS))
                    .font_weight(W_SEMIBOLD)
                    .text_color(if on { t.text } else { t.text_dim })
                    .when(on, |d| d.bg(raised))
                    .when(!on, |d| d.hover(move |s| s.bg(raised)))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        let g = &mut this.items.geo;
                        if g.kind != k {
                            *g =
                                GeoState { kind: k, body: g.body.take(), cache: g.cache.take(), ..GeoState::default() };
                        }
                        cx.notify();
                    }))
                    .child(k.label())
            }));

        let open = |which: GeoMenu| {
            cx.listener(move |this: &mut Self, ev: &ClickEvent, _, cx| {
                this.items.geo.menu = Some((which, ev.position()));
                cx.notify();
            })
        };
        let body_label = body.as_ref().map_or_else(
            || i18n::t("geometry.list.noBodyReason"),
            |b| labels.iter().find(|(id, _)| *id == b.id).map_or(b.name.clone(), |(_, l)| l.clone()),
        );
        let type_label = g.filters.row_type.map_or_else(|| i18n::t("geometry.list.any"), RowType::label);
        let facing_label = g.filters.facing.map_or_else(|| i18n::t("geometry.list.any"), Facing::label);
        let pickers = div()
            .mx(px(14.))
            .mt(px(S_2))
            .flex()
            .flex_col()
            .gap(px(6.))
            .when(kind != GeomKind::Planes, |d| {
                d.child(picker(t, "geo-body", body_label).on_click(open(GeoMenu::Body)))
            })
            .child(
                div()
                    .flex()
                    .gap(px(6.))
                    .when(kind != GeomKind::Planes, |d| {
                        d.child(picker(t, "geo-type", type_label).flex_1().on_click(open(GeoMenu::Type)))
                    })
                    .when(kind != GeomKind::Edges, |d| {
                        d.child(picker(t, "geo-facing", facing_label).flex_1().on_click(open(GeoMenu::Facing)))
                    }),
            );

        let pager = |id: &'static str, label: String, to: Option<usize>, cx: &mut Context<Self>| {
            text(t, FS_MICRO)
                .id(id)
                .font_weight(W_SEMIBOLD)
                .px(px(8.))
                .h(px(22.))
                .flex()
                .items_center()
                .rounded(px(R_PILL))
                .bg(t.raised)
                .text_color(if to.is_some() { t.text_dim } else { t.text_mute })
                .when_some(to, |d, to| {
                    d.on_click(cx.listener(move |this, _, _, cx| {
                        this.items.geo.page = to;
                        cx.notify();
                    }))
                })
                .child(label)
        };
        let summary = div()
            .mx(px(14.))
            .mt(px(S_2))
            .flex()
            .items_center()
            .justify_between()
            .gap(px(S_1))
            .child(text(t, FS_SMALL).text_color(t.text_mute).child(kind.count(filtered.len())))
            .when(pages > 1, |d| {
                d.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(S_1))
                        .child(pager("geo-prev", i18n::t("geometry.list.prev"), page.checked_sub(1), cx))
                        .child(text(t, FS_MICRO).text_color(t.text_mute).child(geo::range_text(page, filtered.len())))
                        .child(pager(
                            "geo-next",
                            i18n::t("geometry.list.next"),
                            (page + 1 < pages).then_some(page + 1),
                            cx,
                        )),
                )
            });

        let body_id = body.as_ref().map(|b| b.id.clone());
        let hover = t.hover_wash;
        let list = filtered.iter().skip(page * PAGE_SIZE).take(PAGE_SIZE).map(|r| {
            let selected = g.selected.as_deref() == Some(r.key.as_str());
            let face = (r.kind == GeomKind::Faces).then(|| body_id.clone()).flatten().map(|id| (id, r.index as u32));
            let viewport = self.viewport.clone();
            let key = r.key.clone();
            div()
                .id(SharedString::from(format!("geo-{}", r.key)))
                .flex_none()
                .px(px(10.))
                .py(px(5.))
                .flex()
                .flex_col()
                .rounded(px(FLOAT_CHIP_RADIUS))
                .when(selected, |d| d.bg(t.accent_wash))
                .when(!selected, |d| d.hover(move |s| s.bg(hover)))
                .when_some(face, |d, face| {
                    d.on_hover(move |on, _, cx| {
                        let face = face.clone();
                        viewport.update(cx, |v, cx| {
                            if *on {
                                v.set_highlight(Some(face), cx);
                            } else {
                                v.clear_highlight(&face, cx);
                            }
                        });
                    })
                })
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.items.geo.selected = Some(key.clone());
                    cx.notify();
                }))
                .child(text(t, FS_BODY).text_color(t.text).truncate().child(r.label.clone()))
                .child(text(t, FS_MICRO).text_color(t.text_mute).truncate().child(r.hint.clone()))
        });
        let list: Vec<AnyElement> = list.map(IntoElement::into_any_element).collect();
        let menu = self.geo_menu(t, &labels, cx);
        div()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .child(segment)
            .child(pickers)
            .child(summary)
            .child(
                div()
                    .id("geo-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .pt(px(S_2))
                    .pb(px(S_2))
                    .px(px(S_2))
                    .flex()
                    .flex_col()
                    .children(list),
            )
            .children(menu)
    }
}
