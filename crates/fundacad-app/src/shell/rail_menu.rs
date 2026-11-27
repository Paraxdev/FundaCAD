//! The tool rail as FundaCAD 1's ToolRail.vue: its content follows the mode (model, selection, sketch, a running
//! tool), a category opens a flyout grid of tiles, a variants family runs its face and shows the rest on a hold or a
//! right click.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use gpui::*;

use super::rail::model::{self, Effect, Entry, Family, Hold, HoldEvent, Mode, Style, Tool};
use super::rail::{self, Button, COMPACT_GAP, COMPACT_TILE, GAP, SEP};
use super::Shell;
use crate::i18n::t;
use crate::motion::glass_in_after;
use crate::theme::{Theme, RAIL_TILE, T_STAGGER};

type Spots = Rc<RefCell<Vec<(SharedString, Bounds<Pixels>)>>>;
type Spot = Rc<Cell<Option<Bounds<Pixels>>>>;

#[derive(Default)]
pub(super) struct RailState {
    /// The family whose flyout is up.
    open: Option<SharedString>,
    hold: Hold,
    pressed: bool,
    timer: Option<Task<()>>,
    /// Each variants family's face, the variant last picked.
    chosen: HashMap<SharedString, SharedString>,
    mode: Option<Mode>,
    rail: Spot,
    flyout: Spot,
    /// The rail's family tiles, to hang the flyout off.
    tiles: Spots,
    /// The flyout's tool tiles, what a hold is released over.
    picks: Spots,
}

#[derive(Clone)]
enum Act {
    Run(SharedString),
    Deselect,
    ExitSketch,
    CancelTool,
    Foot(&'static str),
}

/// The button over the list that names what the rail is showing.
struct Head {
    button: Button,
    act: Act,
}

fn contains(spots: &Spots, at: Point<Pixels>) -> Option<SharedString> {
    spots.borrow().iter().find(|(_, b)| b.contains(&at)).map(|(k, _)| k.clone())
}

fn measure(spots: Spots, key: SharedString) -> impl IntoElement {
    canvas(
        move |b, _, _| {
            let mut s = spots.borrow_mut();
            s.retain(|(k, _)| *k != key);
            s.push((key, b));
        },
        |_, _, _, _| {},
    )
    .absolute()
    .size_full()
}

fn measure_one(cell: Spot) -> impl IntoElement {
    canvas(move |b, _, _| cell.set(Some(b)), |_, _, _, _| {}).absolute().size_full()
}

impl Shell {
    fn rail_mode(&self, cx: &App) -> Mode {
        let v = self.viewport.read(cx);
        let selected = model::Counts::of(v.selection()).primary().is_some();
        model::mode(v.sketching(), v.running().is_some(), selected)
    }

    fn rail_entries(&self, mode: Mode, cx: &App) -> Vec<Entry> {
        let hint = |a: &str| crate::commands::hint(cx, a);
        match mode {
            Mode::Model => {
                let mut out = model::model_rail(&hint);
                // A plugin group shows its first tool's icon, FundaCAD.Printing's print.
                out.push(Entry::Family(Family {
                    id: "Print".into(),
                    label: t("rail.print").into(),
                    glyph: "printing/print".into(),
                    style: Style::Category,
                    items: Vec::new(),
                }));
                out
            }
            Mode::Sketch => model::sketch_rail(&hint),
            Mode::Running => Vec::new(),
            Mode::Selection => {
                let v = self.viewport.read(cx);
                let counts = model::Counts::of(v.selection());
                let built = crate::commands::available(cx);
                let has = |id: &str| built.iter().any(|c| c.id == id);
                let mut out = Vec::new();
                if v.can_sketch_on_selection() {
                    let sketch = model::ribbon_tool("sketch").map(|s| model::tool(&s, &hint));
                    out.extend(sketch.map(|s| Entry::Tool(Tool { action: "sketch-on-face".into(), ..s })));
                }
                out.extend(
                    model::offers(counts)
                        .into_iter()
                        .filter(|id| has(id))
                        .filter_map(model::ribbon_tool)
                        .map(|t| Entry::Tool(model::tool(&t, &hint))),
                );
                if counts.primary().is_some_and(|(k, _)| k == model::Kind::Body) && has("isolate") {
                    out.push(Entry::Tool(Tool {
                        action: "isolate".into(),
                        label: crate::i18n::tr!("rail.look.isolate", n = counts.body).into(),
                        glyph: "isolate".into(),
                        keys: None,
                    }));
                }
                out
            }
        }
    }

    fn rail_head(&self, mode: Mode, cx: &App) -> Option<Head> {
        let v = self.viewport.read(cx);
        let button = |id: &str, glyph: &str, label: String, sub: Option<String>, keys: Option<&str>, lit: bool| Button {
            id: id.to_owned().into(),
            glyph: glyph.to_owned().into(),
            label: label.into(),
            sub: sub.map(Into::into),
            keys: keys.map(|k| SharedString::from(k.to_owned())),
            lit,
            menu: false,
        };
        match mode {
            Mode::Model => None,
            Mode::Sketch => {
                let name =
                    v.sketch_rail().map(|(n, _)| n).filter(|n| !n.is_empty()).unwrap_or_else(|| t("rail.newSketch"));
                let b = button("finish", "close", t("rail.exitSketching"), Some(name), None, false);
                Some(Head { button: b, act: Act::ExitSketch })
            }
            Mode::Running => {
                let run = v.running()?;
                let kind = v
                    .doc()
                    .and_then(|d| crate::tools::feature(d, &run.feature))
                    .and_then(|f| f.get("type").and_then(|t| t.as_str()).map(str::to_owned))
                    .unwrap_or_default();
                let glyph = model::ribbon_tool(&kind).map_or(kind.clone(), |t| t.glyph.to_owned());
                let b = button("running-tool", &glyph, run.title.clone(), None, Some("Esc"), true);
                Some(Head { button: b, act: Act::CancelTool })
            }
            Mode::Selection => {
                let sub = model::summary(model::Counts::of(v.selection()));
                let b = button("deselect", "select-all", t("rail.deselectAll"), sub, Some("Esc"), false);
                Some(Head { button: b, act: Act::Deselect })
            }
        }
    }

    fn rail_act(&mut self, act: Act, window: &mut Window, cx: &mut Context<Self>) {
        self.close_flyout(cx);
        match act {
            Act::Run(a) if a == "sketch-on-face" => self.viewport.update(cx, |v, cx| v.sketch_on_selection(cx)),
            Act::Run(a) => crate::commands::run(&a, window, cx),
            Act::Deselect => self.viewport.update(cx, |v, cx| v.clear_selection(cx)),
            Act::ExitSketch => self.viewport.update(cx, |v, cx| v.finish_sketch(cx)),
            Act::CancelTool => self.viewport.update(cx, |v, cx| v.finish(false, cx)),
            Act::Foot(label) => self.rail_tool(label, window, cx),
        }
    }

    fn close_flyout(&mut self, cx: &mut Context<Self>) {
        let r = &mut self.rail;
        if r.open.is_some() || r.hold != Hold::Idle {
            (r.open, r.hold, r.pressed, r.timer) = (None, Hold::Idle, false, None);
            r.picks.borrow_mut().clear();
            cx.notify();
        }
    }

    fn toggle_category(&mut self, id: SharedString, cx: &mut Context<Self>) {
        let again = self.rail.open.as_ref() == Some(&id);
        self.close_flyout(cx);
        if !again {
            self.rail.open = Some(id);
            cx.notify();
        }
    }

    fn send_hold(&mut self, ev: HoldEvent, window: &mut Window, cx: &mut Context<Self>) {
        let (next, effect) = model::hold_step(&self.rail.hold, ev);
        self.rail.hold = next;
        if !matches!(self.rail.hold, Hold::Pressing { .. }) {
            self.rail.timer = None;
        }
        if self.rail.hold == Hold::Idle {
            self.rail.pressed = false;
        }
        cx.notify();
        let entries = self.rail_entries(self.rail_mode(cx), cx);
        match effect {
            Effect::None => {}
            Effect::Open(id) => self.rail.open = Some(id),
            Effect::Close => {
                // Closing a family kept inside a category leaves the category up.
                self.rail.open = self.rail.open.as_ref().and_then(|o| parent_of(&entries, o));
                self.rail.picks.borrow_mut().clear();
            }
            Effect::RunDefault(id) => {
                let chosen = self.rail.chosen.get(&id).map(|s| s.as_ref());
                let face = model::find(&entries, &id).and_then(|f| model::face_of(f, chosen)).map(|f| f.action.clone());
                if let Some(face) = face {
                    self.rail_act(Act::Run(face), window, cx);
                }
            }
            Effect::Pick { group, action } => {
                self.rail.chosen.insert(group, action.clone());
                self.rail_act(Act::Run(action), window, cx);
            }
        }
    }

    fn press_family(&mut self, f: &Family, right: bool, window: &mut Window, cx: &mut Context<Self>) {
        let (group, variants) = (f.id.clone(), f.items.len() > 1);
        if right {
            return self.send_hold(HoldEvent::ContextMenu { group, variants }, window, cx);
        }
        self.send_hold(HoldEvent::Press { group, variants }, window, cx);
        self.rail.pressed = matches!(self.rail.hold, Hold::Pressing { .. });
        if !self.rail.pressed {
            return;
        }
        self.rail.timer = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(model::HOLD).await;
            let _ = this.update_in(cx, |s, window, cx| s.send_hold(HoldEvent::Hold, window, cx));
        }));
    }

    fn rail_release(&mut self, at: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        if !self.rail.pressed {
            return;
        }
        let over = self.rail.hold.group().cloned().zip(contains(&self.rail.picks, at));
        self.send_hold(HoldEvent::Release { over }, window, cx);
    }

    /// A press outside the rail and its flyout closes the flyout, as FundaCAD 1's Popover.
    fn rail_press_outside(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) {
        let inside = |c: &Spot| c.get().is_some_and(|b| b.contains(&at));
        if self.rail.open.is_some() && !inside(&self.rail.rail) && !inside(&self.rail.flyout) {
            self.close_flyout(cx);
        }
    }

    /// Esc closes an open flyout before anything else hears it.
    pub(super) fn rail_escape(&mut self, cx: &mut Context<Self>) -> bool {
        let open = self.rail.open.is_some();
        self.close_flyout(cx);
        open
    }

    fn rail_button(&self, t: &Theme, b: Button, act: Act, compact: bool, cx: &mut Context<Self>) -> AnyElement {
        let id = ElementId::Name(format!("rail:{}", b.id).into());
        // The tile and the pill occlude the view, which would hide the row's own hitbox, so a cover on top takes the click.
        let cover = div()
            .id(id)
            .absolute()
            .inset_0()
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, window, cx| this.rail_act(act.clone(), window, cx)));
        rail::button(t, b, compact).relative().child(cover).into_any_element()
    }

    fn family_button(&self, t: &Theme, f: &Family, compact: bool, in_flyout: bool, cx: &mut Context<Self>) -> AnyElement {
        let open = self.rail.open.as_ref();
        let holding = self.rail.hold.group() == Some(&f.id);
        let nested_open = open.is_some_and(|o| model::find(&f.items, o).is_some());
        let chosen = self.rail.chosen.get(&f.id).map(|s| s.as_ref());
        let face = if f.style == Style::Variants { model::face_of(f, chosen) } else { None };
        let b = Button {
            id: f.id.clone(),
            glyph: face.map_or(f.glyph.clone(), |t| t.glyph.clone()),
            label: f.label.clone(),
            sub: face.filter(|t| t.label != f.label).map(|t| t.label.clone()),
            keys: face.and_then(|t| t.keys.clone()),
            lit: open == Some(&f.id) || holding || nested_open,
            menu: true,
        };
        let cover = div().id(ElementId::Name(format!("rail-family:{}", f.id).into())).absolute().inset_0().cursor_pointer();
        let cover = match f.style {
            Style::Category => {
                let (left, right) = (f.id.clone(), f.id.clone());
                cover
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |this, _, _, cx| this.toggle_category(left.clone(), cx)))
                    .on_mouse_down(MouseButton::Right, cx.listener(move |this, _, _, cx| this.toggle_category(right.clone(), cx)))
            }
            Style::Variants => {
                let (left, right) = (f.clone(), f.clone());
                cover
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.press_family(&left, false, window, cx);
                        }),
                    )
                    .on_mouse_down(
                        MouseButton::Right,
                        cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.press_family(&right, true, window, cx);
                        }),
                    )
            }
        };
        let el = rail::button(t, b, compact).relative().child(cover);
        let el = if in_flyout { el } else { el.child(measure(self.rail.tiles.clone(), f.id.clone())) };
        el.into_any_element()
    }

    fn entry(&self, t: &Theme, e: &Entry, compact: bool, cx: &mut Context<Self>) -> AnyElement {
        match e {
            Entry::Tool(tool) => self.rail_button(t, tool_button(tool), Act::Run(tool.action.clone()), compact, cx),
            Entry::Family(f) => self.family_button(t, f, compact, false, cx),
        }
    }

    pub(super) fn tool_rail(&mut self, t: &Theme, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let mode = self.rail_mode(cx);
        if self.rail.mode.replace(mode).is_some_and(|m| m != mode) {
            // A mode swap replaces every button, so a flyout would be hanging off nothing.
            self.close_flyout(cx);
            self.rail.tiles.borrow_mut().clear();
        }
        let entries = self.rail_entries(mode, cx);
        let head = self.rail_head(mode, cx);
        let foot: Vec<(Button, Act)> = match mode {
            Mode::Sketch => {
                let on = self.viewport.read(cx).sketch_rail().is_some_and(|(_, c)| c);
                vec![(foot_button("construction", "offset", "Construction", Some(on)), Act::Run("construction".into()))]
            }
            _ => {
                let f = self.rail_foot(cx);
                vec![
                    (foot_button("isolate", "isolate", "Isolate", f.on("Isolate")), Act::Foot("Isolate")),
                    (foot_button("section", "section", "Section View", f.on("Section View")), Act::Foot("Section View")),
                    (foot_button("measure", "measure", "Measure", None), Act::Foot("Measure")),
                ]
            }
        };

        // Smaller tiles and no sub labels once the tools no longer fit the height, a scroll past that.
        let height = self.rail.rail.get().map_or(f32::MAX, |b| b.size.height / px(1.));
        let span = |n: usize| n as f32 * RAIL_TILE + n.saturating_sub(1) as f32 * GAP;
        let rows = 1 + usize::from(head.is_some()) + entries.len();
        let compact = span(rows) + SEP + GAP + span(foot.len()) + 12. > height;
        let gap = if compact { COMPACT_GAP } else { GAP };

        let search = Button {
            id: "search".into(),
            glyph: "search".into(),
            label: crate::i18n::t("rail.search").into(),
            sub: None,
            keys: crate::commands::hint(cx, "find"),
            lit: false,
            menu: false,
        };
        let mut list: Vec<AnyElement> = vec![self.rail_button(t, search, Act::Run("find".into()), compact, cx)];
        list.extend(head.map(|h| self.rail_button(t, h.button, h.act, compact, cx)));
        list.push(div().flex_none().h(px(SEP)).into_any_element());
        list.extend(entries.iter().map(|e| self.entry(t, e, compact, cx)));
        let foot: Vec<AnyElement> = foot.into_iter().map(|(b, act)| self.rail_button(t, b, act, compact, cx)).collect();

        let flyout = self.flyout(t, &entries, compact, window, cx);
        let e = cx.entity().downgrade();
        let listen = canvas(
            |_, _, _| {},
            move |_, _, window, _| {
                let up = e.clone();
                window.on_mouse_event(move |ev: &MouseUpEvent, phase, window, cx| {
                    if phase == DispatchPhase::Capture && ev.button == MouseButton::Left {
                        let _ = up.update(cx, |s, cx| s.rail_release(ev.position, window, cx));
                    }
                });
                let down = e.clone();
                window.on_mouse_event(move |ev: &MouseDownEvent, phase, _, cx| {
                    if phase == DispatchPhase::Capture {
                        let _ = down.update(cx, |s, cx| s.rail_press_outside(ev.position, cx));
                    }
                });
            },
        )
        .absolute()
        .size_full();

        div()
            .relative()
            .h_full()
            .child(measure_one(self.rail.rail.clone()))
            .child(listen)
            .child(
                div()
                    .h_full()
                    .flex()
                    .flex_col()
                    .justify_between()
                    .gap(px(gap))
                    .child(
                        div()
                            .id("rail-list")
                            .flex_shrink_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .flex()
                            .flex_col()
                            .gap(px(gap))
                            .children(list),
                    )
                    .child(div().flex_none().flex().flex_col().gap(px(gap)).children(foot)),
            )
            .children(flyout)
    }

    /// The open family's tools as FundaCAD 1's rail flyout: a grid of rail tiles filled down then across, each gliding
    /// in after the one before it.
    fn flyout(
        &mut self,
        t: &Theme,
        entries: &[Entry],
        compact: bool,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let id = self.rail.open.clone()?;
        let family = model::find(entries, &id)?.clone();
        if family.items.is_empty() {
            return None;
        }
        let top_id = top_of(entries, &id).unwrap_or(id.clone());
        let anchor = self.rail.tiles.borrow().iter().find(|(k, _)| *k == top_id).map(|(_, b)| b.origin.y);
        let rail = self.rail.rail.get();
        let win_h = window.viewport_size().height / px(1.);
        let rows = model::flyout_rows(family.items.len(), win_h);
        let tile = if compact { COMPACT_TILE } else { RAIL_TILE };
        let grid_h = rows as f32 * tile + rows.saturating_sub(1) as f32 * GAP;
        let rail_h = rail.map_or(win_h, |b| b.size.height / px(1.));
        let top = match (anchor, rail) {
            (Some(a), Some(r)) => ((a - r.origin.y) / px(1.)).min(rail_h - grid_h).max(0.),
            _ => 0.,
        };
        self.rail.picks.borrow_mut().clear();
        let mut cols: Vec<Vec<AnyElement>> = Vec::new();
        for (i, e) in family.items.iter().enumerate() {
            let el = match e {
                Entry::Tool(tool) => {
                    let (fam, action) = (family.clone(), tool.action.clone());
                    let pick = ElementId::Name(format!("rail-pick:{action}").into());
                    let cover = div().id(pick).absolute().inset_0().cursor_pointer().on_click(cx.listener(
                        move |this, _, window, cx| {
                            if fam.style == Style::Variants {
                                this.rail.chosen.insert(fam.id.clone(), action.clone());
                            }
                            this.rail_act(Act::Run(action.clone()), window, cx);
                        },
                    ));
                    rail::button(t, tool_button(tool), compact)
                        .relative()
                        .child(cover)
                        .child(measure(self.rail.picks.clone(), tool.action.clone()))
                        .into_any_element()
                }
                Entry::Family(f) => self.family_button(t, f, compact, true, cx),
            };
            let glide = ElementId::Name(format!("rail-fly-in:{id}:{}", e.key()).into());
            if i % rows == 0 {
                cols.push(Vec::new());
            }
            let el = glass_in_after(glide, T_STAGGER * i as u32, div().child(el)).into_any_element();
            cols.last_mut().expect("pushed above").push(el);
        }
        let grid = div()
            .id(ElementId::Name(format!("rail-flyout:{id}").into()))
            .absolute()
            .left_full()
            .top(px(top))
            .ml(px(6.))
            .flex()
            .items_start()
            .gap(px(14.))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(measure_one(self.rail.flyout.clone()))
            .children(cols.into_iter().map(|c| div().flex().flex_col().gap(px(GAP)).children(c)));
        Some(grid.into_any_element())
    }
}

fn tool_button(tool: &Tool) -> Button {
    Button {
        id: tool.action.clone(),
        glyph: tool.glyph.clone(),
        label: tool.label.clone(),
        sub: None,
        keys: tool.keys.clone(),
        lit: false,
        menu: false,
    }
}

fn foot_button(id: &str, glyph: &str, label: &'static str, on: Option<bool>) -> Button {
    Button {
        id: id.to_owned().into(),
        glyph: glyph.to_owned().into(),
        label: rail::spoken(label),
        sub: on.map(|on| rail::spoken(if on { "On" } else { "Off" })),
        keys: None,
        lit: on == Some(true),
        menu: false,
    }
}

/// The category a family kept inside it belongs to.
fn parent_of(entries: &[Entry], id: &str) -> Option<SharedString> {
    entries.iter().find_map(|e| match e {
        Entry::Family(f) if f.items.iter().any(|i| matches!(i, Entry::Family(c) if c.id == id)) => Some(f.id.clone()),
        _ => None,
    })
}

/// The rail tile a family hangs off: its own, or its category's.
fn top_of(entries: &[Entry], id: &str) -> Option<SharedString> {
    entries.iter().find_map(|e| match e {
        Entry::Family(f) if f.id == id || model::find(&f.items, id).is_some() => Some(f.id.clone()),
        _ => None,
    })
}
