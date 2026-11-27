use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;

use fundacad_client::Doc;
use gpui::prelude::FluentBuilder as _;
use gpui::*;
use gpui_kit::component::input::{Input, InputEvent, InputState};

use super::geometry::GeoState;
use super::Shell;
use crate::i18n::{self, tr};
use crate::items::{self, BodyRef, Category, Eye, Filter, Inputs, Kind, Mods, Node, Rename, Selection};
use crate::motion::{hover_bg, pop_in, row_bg, Transition};
use crate::theme::{Rgb, Theme, FLOAT_CHIP_RADIUS, FS_BODY, FS_MICRO, FS_SMALL, R_PILL, S_1, S_2, W_SEMIBOLD};
use crate::ui::{float_card, icon, icon_button, solid_card, text};

pub(super) const WIDTH: f32 = 264.;
const ROW: f32 = 33.;

/// The head every float card shares: a title and a close button.
pub(super) fn card_head(t: &Theme, id: &'static str, title: String) -> Div {
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(S_2))
        .pt(px(10.))
        .pr(px(10.))
        .pb(px(6.))
        .pl(px(14.))
        .child(text(t, FS_BODY).font_weight(W_SEMIBOLD).child(title))
        .child(icon_button(t, SharedString::from(format!("{id}-close")), "close", 28., 14., t.text_mute))
}

/// A visibility change for one category, `groups` holding the bodies behind each `g:` folder key.
type VisEdit = (Category, Vec<(String, bool)>, HashMap<String, Vec<String>>);

#[derive(Clone)]
enum Act {
    Vis(Vec<VisEdit>),
    ShowOnly(Category, Vec<String>),
    ShowAll(Category),
    ShowHidden,
    Invert,
    Rename(String),
    Filter(Filter),
    Plugin(Rc<dyn Fn(&mut Window, &mut App)>),
}

/// Local stand-ins for the shared menu component, each a list of labelled acts, easy to swap later.
enum Menu {
    Filter(Point<Pixels>),
    More(Point<Pixels>),
    Row(Point<Pixels>, Vec<(String, Act)>),
}

struct Renaming {
    key: String,
    target: Rename,
    before: String,
    input: Entity<InputState>,
    _events: Subscription,
}

pub(super) struct ItemsState {
    collapse: items::Collapse,
    filter: Filter,
    pub(super) selection: Selection,
    solo: items::Solo,
    menu: Option<Menu>,
    renaming: Option<Renaming>,
    focus: FocusHandle,
    pub(super) geo: GeoState,
}

impl ItemsState {
    pub(super) fn new(cx: &mut Context<Shell>) -> Self {
        Self {
            collapse: items::Collapse::default(),
            filter: Filter::All,
            selection: Selection::default(),
            solo: items::Solo::default(),
            menu: None,
            renaming: None,
            focus: cx.focus_handle(),
            geo: GeoState::default(),
        }
    }
}

fn mods(m: &Modifiers) -> Mods {
    Mods { toggle: m.control || m.platform, range: m.shift }
}

fn folder_category(key: &str) -> Option<Category> {
    match key {
        "f:Bodies" => Some(Category::Bodies),
        "f:Sketches" => Some(Category::Sketches),
        "f:Planes" => Some(Category::Planes),
        "f:Datums" => Some(Category::Datums),
        _ => None,
    }
}

/// The change an eye makes, a folder head's eye standing for every body under it.
/// "Hide 2 items" for undo, which a diff of the document cannot word.
fn vis_label(edits: &[VisEdit]) -> String {
    let changes: Vec<bool> = edits.iter().flat_map(|(_, c, _)| c.iter().map(|(_, v)| *v)).collect();
    let n = changes.len();
    let show = match (changes.iter().all(|v| *v), changes.iter().all(|v| !v)) {
        (true, _) => "yes",
        (_, true) => "no",
        _ => return i18n::t("items.vis.title"),
    };
    tr!("items.vis.changed", show = show, n = n)
}

fn eye_edit(eye: &Eye, visible: bool) -> VisEdit {
    let groups = if eye.ids.is_empty() { HashMap::new() } else { HashMap::from([(eye.key.clone(), eye.ids.clone())]) };
    (eye.category, vec![(eye.key.clone(), visible)], groups)
}

fn flat_ids(eye: &Eye) -> Vec<String> {
    if eye.ids.is_empty() {
        vec![eye.key.clone()]
    } else {
        eye.ids.clone()
    }
}

/// A floating menu at `pos`, closed by a press anywhere else.
pub(super) fn popup(
    t: &Theme,
    pos: Point<Pixels>,
    close: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
    rows: Vec<AnyElement>,
) -> impl IntoElement {
    deferred(
        anchored().position(pos).snap_to_window_with_margin(px(8.)).child(
            pop_in(
                SharedString::from(format!("popup:{}:{}", f32::from(pos.x) as i32, f32::from(pos.y) as i32)),
                solid_card(t)
                    .bg(t.float_bg_solid)
                    .min_w(px(180.))
                    .p(px(S_1))
                    .on_mouse_down_out(close)
                    .children(rows),
            ),
        ),
    )
    .with_priority(1)
}

pub(super) fn menu_row(
    t: &Theme,
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    on: bool,
) -> Transition<Stateful<Div>> {
    let id = id.into();
    let row = text(t, FS_SMALL)
        .id(id.clone())
        .h(px(28.))
        .px(px(10.))
        .flex()
        .items_center()
        .justify_between()
        .gap(px(S_2))
        .rounded(px(FLOAT_CHIP_RADIUS))
        .child(label.into())
        .when(on, |d| d.child(icon("check", 12., t.accent)));
    hover_bg(id, row, Rgb::TRANSPARENT, t.hover_wash)
}

/// A field-like chip that opens a dropdown, used by the filter and the Geometry pickers.
pub(super) fn picker(t: &Theme, id: impl Into<ElementId>, label: impl Into<SharedString>) -> Stateful<Div> {
    text(t, FS_MICRO)
        .id(id)
        .font_weight(W_SEMIBOLD)
        .h(px(30.))
        .px(px(11.))
        .flex()
        .items_center()
        .justify_between()
        .gap(px(S_1))
        .rounded(px(FLOAT_CHIP_RADIUS))
        .bg(t.field_bg)
        .border_1()
        .border_color(t.control_edge)
        .child(div().min_w_0().truncate().child(label.into()))
        .child(icon("caretDown", 10., t.text_dim))
}

impl Shell {
    pub(super) fn built(&self, cx: &App) -> Vec<BodyRef> {
        self.viewport.read(cx).bodies().iter().map(|b| BodyRef::of(b)).collect()
    }

    fn item_nodes(&self, cx: &App) -> Vec<Node> {
        let built = self.built(cx);
        let errors: HashSet<String> = self
            .viewport
            .read(cx)
            .feature_issues()
            .iter()
            .filter(|i| !i.warning)
            .map(|i| i.feature_id.clone())
            .collect();
        let empty = Doc::new();
        let doc = self.source.as_ref().unwrap_or(&empty);
        items::nodes(&Inputs {
            doc,
            bodies: &built,
            collapse: &self.items.collapse,
            filter: self.items.filter,
            errors: &errors,
        })
    }

    fn set_vis(&mut self, edits: Vec<VisEdit>, cx: &mut Context<Self>) {
        let label = vis_label(&edits);
        let edited = self.viewport.update(cx, |v, cx| {
            v.edit_step(
                None,
                Some(label),
                move |d| {
                    for (category, changes, groups) in &edits {
                        items::set_visibility(d, *category, changes, groups)?;
                    }
                    Ok(())
                },
                cx,
            )
        });
        if let Err(why) = edited {
            log::info!("the visibility change was not applied: {why}");
        }
    }

    fn rows_of(&self, category: Category, cx: &App) -> BTreeMap<String, bool> {
        let empty = Doc::new();
        items::vis_rows(self.source.as_ref().unwrap_or(&empty), &self.built(cx), category)
    }

    fn act(&mut self, act: Act, window: &mut Window, cx: &mut Context<Self>) {
        self.items.menu = None;
        match act {
            Act::Vis(edits) => {
                for (c, _, _) in &edits {
                    self.items.solo.forget(*c);
                }
                self.set_vis(edits, cx);
            }
            Act::ShowOnly(c, keys) => {
                self.items.solo.forget(c);
                let changes = items::show_only(&self.rows_of(c, cx), &keys);
                self.set_vis(vec![(c, changes, HashMap::new())], cx);
            }
            Act::ShowAll(c) => {
                self.items.solo.forget(c);
                let changes = items::all(self.rows_of(c, cx).into_keys(), true);
                self.set_vis(vec![(c, changes, HashMap::new())], cx);
            }
            Act::ShowHidden => {
                self.items.solo.forget(Category::Bodies);
                let hidden = self.rows_of(Category::Bodies, cx).into_iter().filter(|(_, v)| !v).map(|(k, _)| k);
                self.set_vis(vec![(Category::Bodies, items::all(hidden, true), HashMap::new())], cx);
            }
            Act::Invert => {
                self.items.solo.forget(Category::Bodies);
                let changes = items::invert(&self.rows_of(Category::Bodies, cx));
                self.set_vis(vec![(Category::Bodies, changes, HashMap::new())], cx);
            }
            Act::Rename(key) => self.start_rename(&key, window, cx),
            Act::Filter(f) => self.items.filter = f,
            Act::Plugin(run) => run(window, cx),
        }
        cx.notify();
    }

    fn eye_down(&mut self, eye: &Eye, alt: bool, cx: &mut Context<Self>) {
        if !alt {
            self.items.solo.forget(eye.category);
            self.set_vis(vec![eye_edit(eye, !eye.visible)], cx);
            return;
        }
        let rows = self.rows_of(eye.category, cx);
        let changes = if eye.ids.is_empty() {
            self.items.solo.toggle(eye.category, &eye.key, &rows)
        } else {
            self.items.solo.forget(eye.category);
            items::show_only(&rows, &eye.ids)
        };
        self.set_vis(vec![(eye.category, changes, HashMap::new())], cx);
    }

    fn row_click(&mut self, node: &Node, ev: &ClickEvent, nodes: &[Node], window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.items.focus, cx);
        self.items.menu = None;
        let m = mods(&ev.modifiers());
        if ev.click_count() >= 2 && node.rename.is_some() && !m.toggle && !m.range {
            self.start_rename(&node.k, window, cx);
            return;
        }
        match &node.kind {
            Kind::Folder { .. } if node.k.starts_with("f:") => self.items.collapse.toggle(&node.k),
            Kind::Folder { members, .. } => {
                let members: Vec<String> = members.iter().map(|id| format!("b:{id}")).collect();
                let keys = items::select_group(&self.items.selection.keys, &members, m);
                self.items.selection = Selection { keys, anchor: self.items.selection.anchor.clone() };
            }
            Kind::Row => {
                let prefix = node.k.split_once(':').map_or("", |(p, _)| p);
                let order: Vec<String> = nodes
                    .iter()
                    .filter(|n| n.kind == Kind::Row && n.k.split_once(':').is_some_and(|(p, _)| p == prefix))
                    .map(|n| n.k.clone())
                    .collect();
                self.items.selection = items::select_row(&self.items.selection, &order, &node.k, m);
            }
            Kind::Empty => {}
        }
        self.picks_from_items(cx);
        cx.notify();
    }

    fn row_menu(&mut self, node: &Node, pos: Point<Pixels>, nodes: &[Node], cx: &mut Context<Self>) {
        let mut acts: Vec<(String, Act)> = Vec::new();
        if let Some(c) = folder_category(&node.k) {
            acts.push((c.show_all_label().to_string(), Act::ShowAll(c)));
        }
        if let Some(eye) = &node.eye {
            if node.kind == Kind::Row {
                let keys = items::act_on(&self.items.selection.keys, &node.k);
                self.items.selection = Selection { keys, anchor: Some(node.k.clone()) };
            }
            let picked: Vec<&Eye> = nodes
                .iter()
                .filter(|n| n.k == node.k || (n.kind == Kind::Row && self.items.selection.has(&n.k)))
                .filter_map(|n| n.eye.as_ref())
                .filter(|e| e.category == eye.category)
                .collect();
            let n = picked.len();
            let edit = |visible: bool| {
                let mut changes = Vec::new();
                let mut groups = HashMap::new();
                for e in &picked {
                    let (_, c, g) = eye_edit(e, visible);
                    changes.extend(c);
                    groups.extend(g);
                }
                Act::Vis(vec![(eye.category, changes, groups)])
            };
            let (show, hide) = if n > 1 {
                (tr!("items.vis.showThese", n = n), tr!("items.vis.hideThese", n = n))
            } else {
                (i18n::t("items.row.show"), i18n::t("items.row.hide"))
            };
            acts.push((show, edit(true)));
            acts.push((hide, edit(false)));
            let only: Vec<String> = picked.iter().flat_map(|e| flat_ids(e)).collect();
            acts.push((tr!("items.vis.showOnly", n = n), Act::ShowOnly(eye.category, only)));
            acts.push((eye.category.show_all_label().to_string(), Act::ShowAll(eye.category)));
        }
        if node.rename.is_some() {
            acts.push((i18n::t("items.row.rename"), Act::Rename(node.k.clone())));
        }
        if let (Some(body), Some(doc)) = (node.k.strip_prefix("b:"), self.source.clone()) {
            let mut owners: Vec<String> = Vec::new();
            for b in self.viewport.read(cx).bodies().iter().filter(|b| b.id == body) {
                for o in b.face_owners.iter().flatten() {
                    if !owners.contains(o) {
                        owners.push(o.clone());
                    }
                }
            }
            for row in crate::plugins::body_menu(cx, &doc, &owners) {
                acts.push((row.label.to_string(), Act::Plugin(row.run)));
            }
        }
        self.items.menu = (!acts.is_empty()).then_some(Menu::Row(pos, acts));
        cx.notify();
    }

    fn start_rename(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        let nodes = self.item_nodes(cx);
        let Some(node) = nodes.iter().find(|n| n.k == key) else { return };
        let Some(target) = node.rename.clone() else { return };
        let before = node.label.clone();
        let input = cx.new(|cx| InputState::new(window, cx).default_value(before.clone()));
        let events = cx.subscribe_in(&input, window, |this, _, event: &InputEvent, window, cx| {
            if matches!(event, InputEvent::PressEnter { .. } | InputEvent::Blur) {
                this.commit_rename(window, cx);
            }
        });
        input.update(cx, |i, cx| {
            i.focus(window, cx);
            i.select_all(window, cx);
        });
        self.items.renaming = Some(Renaming { key: key.to_string(), target, before, input, _events: events });
        cx.notify();
    }

    fn commit_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(r) = self.items.renaming.take() else { return };
        let name = r.input.read(cx).value().to_string();
        if name.trim() != r.before.trim() {
            let target = r.target.clone();
            let label = Some(tr!("step.label.rename", step = r.before.trim()));
            let edited = self
                .viewport
                .update(cx, |v, cx| v.edit_step(None, label, move |d| items::rename(d, &target, &name), cx));
            if let Err(why) = edited {
                log::info!("the rename was not applied: {why}");
            }
        }
        window.focus(&self.items.focus, cx);
        cx.notify();
    }

    fn cancel_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.items.renaming.take().is_some() {
            window.focus(&self.items.focus, cx);
            cx.notify();
        }
    }

    fn key_down(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        match ev.keystroke.key.as_str() {
            "f2" => {
                let [key] = self.items.selection.keys.as_slice() else { return };
                let key = key.clone();
                self.start_rename(&key, window, cx);
            }
            "escape" if self.items.menu.is_some() => {
                self.items.menu = None;
                cx.notify();
            }
            "escape" => {
                self.items.selection = Selection::default();
                cx.notify();
            }
            _ => {}
        }
    }

    fn item_row(&self, t: &Theme, node: &Node, nodes: &Rc<Vec<Node>>, cx: &mut Context<Self>) -> AnyElement {
        if node.kind == Kind::Empty {
            return text(t, FS_SMALL)
                .h(px(ROW))
                .flex()
                .items_center()
                .pl(px(items::row_indent(node.depth)))
                .text_color(t.text_mute)
                .child(node.label.clone())
                .into_any_element();
        }
        let folder = node.is_folder();
        let selected = self.items.selection.has(&node.k);
        let hidden = node.eye.as_ref().is_some_and(|e| !e.visible);
        let indent = if folder { items::folder_indent(node.depth) } else { items::row_indent(node.depth) };
        let color: Hsla = if node.error {
            t.error.into()
        } else if node.dim || node.suppressed || hidden {
            t.text_mute.into()
        } else if folder {
            t.text.into()
        } else {
            t.text_dim.into()
        };
        let renaming = self.items.renaming.as_ref().filter(|r| r.key == node.k);
        let label: AnyElement = match renaming {
            Some(r) => div()
                .flex_1()
                .min_w_0()
                .h(px(24.))
                .px(px(6.))
                .flex()
                .items_center()
                .rounded(px(FLOAT_CHIP_RADIUS))
                .bg(t.field_bg)
                .border_1()
                .border_color(t.accent)
                .capture_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                    if ev.keystroke.key == "escape" {
                        cx.stop_propagation();
                        this.cancel_rename(window, cx);
                    }
                }))
                .child(
                    Input::new(&r.input)
                        .appearance(false)
                        .bordered(false)
                        .focus_bordered(false)
                        .text_size(px(FS_BODY))
                        .p_0(),
                )
                .into_any_element(),
            None => text(t, FS_BODY)
                .flex_1()
                .min_w_0()
                .truncate()
                .text_color(color)
                .when(folder, |d| d.font_weight(W_SEMIBOLD))
                .when(node.suppressed, |d| d.line_through())
                .child(node.label.clone())
                .into_any_element(),
        };
        let caret = folder.then(|| {
            let collapsed = matches!(node.kind, Kind::Folder { collapsed: true, .. });
            let key = node.k.clone();
            div()
                .id(SharedString::from(format!("caret-{}", node.k)))
                .size(px(14.))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .on_click(cx.listener(move |this, _, _, cx| {
                    cx.stop_propagation();
                    this.items.collapse.toggle(&key);
                    cx.notify();
                }))
                .child(icon(if collapsed { "caretRight" } else { "caretDown" }, 12., t.text_mute))
        });
        let badge = match &node.kind {
            Kind::Folder { count, .. } => Some(
                text(t, FS_MICRO)
                    .font_weight(W_SEMIBOLD)
                    .flex_none()
                    .min_w(px(20.))
                    .h(px(16.))
                    .px(px(5.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(R_PILL))
                    .bg(t.raised)
                    .text_color(t.text_dim)
                    .child(count.to_string()),
            ),
            _ => None,
        };
        let raised = t.raised;
        let eye = node.eye.clone().map(|eye| {
            let visible = eye.visible;
            let eye = div()
                .id(SharedString::from(format!("eye-{}", node.k)))
                .size(px(20.))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(FLOAT_CHIP_RADIUS))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, ev: &MouseDownEvent, _, cx| {
                        cx.stop_propagation();
                        this.eye_down(&eye, ev.modifiers.alt, cx);
                    }),
                )
                .child(icon(if visible { "visible" } else { "hidden" }, 14., t.text_mute));
            hover_bg(SharedString::from(format!("eye-bg-{}", node.k)), eye, Rgb::TRANSPARENT, raised)
        });
        let (click, menu) = (node.clone(), node.clone());
        let (click_nodes, menu_nodes) = (nodes.clone(), nodes.clone());
        let row = div()
            .id(SharedString::from(format!("row-{}", node.k)))
            .flex_none()
            .h(px(ROW))
            .flex()
            .items_center()
            .pl(px(indent))
            .pr(px(6.))
            .gap(px(8.))
            .rounded(px(FLOAT_CHIP_RADIUS))
            .on_click(cx.listener(move |this, ev: &ClickEvent, window, cx| {
                this.row_click(&click, ev, &click_nodes, window, cx);
            }))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, ev: &MouseDownEvent, window, cx| {
                    window.focus(&this.items.focus, cx);
                    this.row_menu(&menu, ev.position, &menu_nodes, cx);
                }),
            )
            .children(caret)
            .child(icon(node.icon, 14., if node.error { t.error.into() } else { Hsla::from(t.text_dim) }))
            .child(label)
            .children(badge)
            .children(eye);
        let id = SharedString::from(format!("row-bg-{}", node.k));
        row_bg(id, row, selected, t.hover_wash, t.accent_wash).into_any_element()
    }

    fn items_menu(&self, t: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (pos, acts): (Point<Pixels>, Vec<(String, Act, bool)>) = match self.items.menu.as_ref()? {
            Menu::Filter(pos) => (
                *pos,
                items::FILTERS
                    .iter()
                    .map(|f| (f.label().to_string(), Act::Filter(*f), *f == self.items.filter))
                    .collect(),
            ),
            Menu::More(pos) => {
                let mut by: HashMap<Category, Vec<(String, bool)>> = HashMap::new();
                let mut groups = HashMap::new();
                for n in self.item_nodes(cx).into_iter().filter(|n| self.items.selection.has(&n.k)) {
                    let Some(e) = n.eye else { continue };
                    let (c, ch, g) = eye_edit(&e, false);
                    by.entry(c).or_default().extend(ch);
                    groups.extend(g);
                }
                let hide: Vec<VisEdit> = by.into_iter().map(|(c, ch)| (c, ch, groups.clone())).collect();
                let mut acts = Vec::new();
                if !hide.is_empty() {
                    acts.push((i18n::t("items.more.hideSelected"), Act::Vis(hide), false));
                }
                acts.push((i18n::t("items.more.showHidden"), Act::ShowHidden, false));
                acts.push((i18n::t("items.more.invert"), Act::Invert, false));
                (*pos, acts)
            }
            Menu::Row(pos, acts) => (*pos, acts.iter().map(|(l, a)| (l.clone(), a.clone(), false)).collect()),
        };
        let rows = acts
            .into_iter()
            .enumerate()
            .map(|(i, (label, act, on))| {
                menu_row(t, ("items-menu", i), label, on)
                    .on_click(cx.listener(move |this, _, window, cx| this.act(act.clone(), window, cx)))
                    .into_any_element()
            })
            .collect();
        let close = cx.listener(|this, _: &MouseDownEvent, _, cx| {
            this.items.menu = None;
            cx.notify();
        });
        Some(popup(t, pos, close, rows).into_any_element())
    }

    pub(super) fn items_card(&mut self, t: &Theme, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let tab = |i: usize, label: &'static str, cx: &mut Context<Self>| {
            let on = self.items_tab == i;
            text(t, FS_BODY)
                .id(label)
                .font_weight(W_SEMIBOLD)
                .pt(px(S_1))
                .px(px(S_2))
                .pb(px(6.))
                .relative()
                .text_color(if on { t.text } else { t.text_dim })
                .when(on, |d| {
                    d.child(
                        div()
                            .absolute()
                            .left(relative(0.25))
                            .right(relative(0.25))
                            .bottom_0()
                            .h(px(2.))
                            .rounded(px(R_PILL))
                            .bg(t.accent),
                    )
                })
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.items_tab = i;
                    this.items.menu = None;
                    this.items.geo.menu = None;
                    this.viewport.update(cx, |v, cx| v.set_highlight(None, cx));
                    cx.notify();
                }))
                .child(i18n::t(label))
        };
        let tabs = div().flex().pl(px(5.)).child(tab(0, "items.tab.items", cx)).child(tab(1, "items.tab.geometry", cx));
        let card = float_card(t).w(px(WIDTH)).flex_1().min_h_0().child(card_head(t, "Items", i18n::t("items.title"))).child(tabs);
        if self.items_tab == 1 {
            return card.child(self.geometry_tab(t, window, cx));
        }

        let filter = picker(t, "items-filter", self.items.filter.label()).mx(px(14.)).mt(px(S_2)).on_click(
            cx.listener(|this, ev: &ClickEvent, _, cx| {
                this.items.menu = Some(Menu::Filter(ev.position()));
                cx.notify();
            }),
        );
        let nodes = Rc::new(self.item_nodes(cx));
        let rows: Vec<AnyElement> = nodes.iter().map(|n| self.item_row(t, n, &nodes, cx)).collect();
        let more = icon_button(t, "items-more", "more", 24., 15., t.text_mute).on_click(cx.listener(
            |this, ev: &ClickEvent, _, cx| {
                this.items.menu = Some(Menu::More(ev.position()));
                cx.notify();
            },
        ));
        let menu = self.items_menu(t, cx);
        card.track_focus(&self.items.focus)
            .on_key_down(cx.listener(Self::key_down))
            .child(filter)
            .child(
                div()
                    .id("items-groups")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .pt(px(14.))
                    .px(px(S_2))
                    .flex()
                    .flex_col()
                    .children(rows),
            )
            .child(div().flex().justify_end().p(px(S_2)).child(more))
            .children(menu)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{vis_label, Category};

    #[test]
    fn a_visibility_change_is_worded_for_undo() {
        let edit = |c: &[bool]| (Category::Bodies, c.iter().map(|v| ("b".to_string(), *v)).collect(), HashMap::new());
        assert_eq!(vis_label(&[edit(&[false])]), "Hide 1 item");
        assert_eq!(vis_label(&[edit(&[true, true])]), "Show 2 items");
        assert_eq!(vis_label(&[edit(&[true]), edit(&[false])]), "Visibility");
    }
}
