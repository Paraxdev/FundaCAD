//! The wasmtime side: the component world, a store per call and the host API.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use fundacad_core::schema::{Num, OneOrMany, Selector};
use fundacad_protocol::CancelToken;
use opencascade::primitives::Shape;
use serde_json::Value;
use wasmtime::component::{HasSelf, Linker, Resource, ResourceTable};
use wasmtime::{Config, Engine, Store, StoreLimits, StoreLimitsBuilder, UpdateDeadline};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

use super::kernel_api as k;
use crate::builder::Ctx;

pub mod wit {
    wasmtime::component::bindgen!({
        world: "plugin",
        path: "wit",
        with: {
            "fundacad:plugin/kernel.shape": super::HostShape,
        },
        imports: { default: trappable },
    });
}

pub use wit::fundacad::plugin::{feature, host as host_api, kernel, output, types};
use wit::{Plugin, PluginPre, Registration};

/// A kernel shape held for a plugin.
pub struct HostShape(pub Shape);

// The store, and every shape in it, lives and dies on the job thread that made
// it; wasmtime only asks for Send because a store could move.
unsafe impl Send for HostShape {}

pub type MeshData = types::Mesh;
pub type ExportMesh = types::ExportBody;

struct FeatureScope {
    ctx: *mut Ctx,
    raw: Value,
    feature_id: Option<String>,
}

enum Scope {
    None,
    Feature(FeatureScope),
    Export(PathBuf),
}

pub struct State {
    table: ResourceTable,
    wasi: WasiCtx,
    limits: StoreLimits,
    scope: Scope,
    cancel: Option<CancelToken>,
}

// FeatureScope's pointer is only dereferenced inside the synchronous call that
// set it, on the thread that owns the `Ctx`.
unsafe impl Send for State {}

impl WasiView for State {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

fn engine() -> &'static Engine {
    static ENGINE: OnceLock<Engine> = OnceLock::new();
    ENGINE.get_or_init(|| {
        let mut cfg = Config::new();
        cfg.wasm_component_model(true)
            .epoch_interruption(true)
            .max_wasm_stack(8 << 20);
        Engine::new(&cfg).expect("the wasmtime configuration is valid")
    })
}

const TICK: Duration = Duration::from_millis(20);

/// Advances the engine epoch while a call runs.
struct Ticker(Arc<AtomicBool>);

impl Ticker {
    fn start() -> Ticker {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        std::thread::spawn(move || {
            while !flag.load(Ordering::Relaxed) {
                std::thread::sleep(TICK);
                engine().increment_epoch();
            }
        });
        Ticker(stop)
    }
}

impl Drop for Ticker {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

pub struct Component {
    pre: PluginPre<State>,
    pub registration: Registration,
}

fn text(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// A trap as the person reads it.
fn trap_text(e: wasmtime::Error) -> String {
    if let Some(t) = e.downcast_ref::<wasmtime::Trap>() {
        if *t == wasmtime::Trap::Interrupt {
            return "the plugin ran out of time or was cancelled".into();
        }
    }
    let s = format!("{e:#}");
    if s.contains("cancelled") || s.contains("time budget") {
        return s;
    }
    format!("the plugin crashed: {s}")
}

impl Component {
    pub fn load(path: &Path) -> Result<Component, String> {
        let component = wasmtime::component::Component::from_file(engine(), path).map_err(text)?;
        let mut linker: Linker<State> = Linker::new(engine());
        wasmtime_wasi::p2::add_to_linker_sync(&mut linker).map_err(text)?;
        Plugin::add_to_linker::<_, HasSelf<_>>(&mut linker, |s| s).map_err(text)?;
        let pre = PluginPre::new(linker.instantiate_pre(&component).map_err(text)?).map_err(text)?;
        let mut c = Component {
            pre,
            registration: Registration {
                features: vec![],
                mesh_passes: vec![],
                exporters: vec![],
                shape_generators: vec![],
            },
        };
        c.registration = c.call(Scope::None, Duration::from_secs(10), None, |p, s| {
            p.call_register(s)
        })?;
        Ok(c)
    }

    fn call<R>(
        &self,
        scope: Scope,
        budget: Duration,
        cancel: Option<CancelToken>,
        f: impl FnOnce(&Plugin, &mut Store<State>) -> wasmtime::Result<R>,
    ) -> Result<R, String> {
        let wasi = WasiCtxBuilder::new()
            .inherit_stderr()
            .allow_tcp(false)
            .allow_udp(false)
            .allow_ip_name_lookup(false)
            .build();
        let limits = StoreLimitsBuilder::new()
            .memory_size(super::MEMORY_LIMIT)
            .table_elements(1 << 20)
            .instances(64)
            .tables(64)
            .memories(8)
            .trap_on_grow_failure(true)
            .build();
        let mut store = Store::new(
            engine(),
            State {
                table: ResourceTable::new(),
                wasi,
                limits,
                scope,
                cancel: cancel.clone(),
            },
        );
        store.limiter(|s| &mut s.limits);
        let started = Instant::now();
        store.epoch_deadline_callback(move |ctx| {
            if ctx.data().cancel.as_ref().is_some_and(CancelToken::is_cancelled) {
                return Err(wasmtime::Error::msg("cancelled"));
            }
            if started.elapsed() > budget {
                return Err(wasmtime::Error::msg(format!(
                    "the plugin ran past its time budget of {} s",
                    budget.as_secs()
                )));
            }
            Ok(UpdateDeadline::Continue(1))
        });
        store.set_epoch_deadline(1);
        let _ticker = Ticker::start();
        let plugin = self.pre.instantiate(&mut store).map_err(trap_text)?;
        f(&plugin, &mut store).map_err(trap_text)
    }

    pub fn run_feature(
        &self,
        ctx: &mut Ctx,
        type_name: &str,
        raw: &Value,
        cancel: Option<CancelToken>,
    ) -> Result<(), String> {
        let scope = Scope::Feature(FeatureScope {
            ctx: ctx as *mut Ctx,
            raw: raw.clone(),
            feature_id: raw.get("id").and_then(Value::as_str).map(str::to_owned),
        });
        self.call(scope, super::FEATURE_BUDGET, cancel, |p, s| {
            p.call_run_feature(s, type_name)
        })?
    }

    pub fn generate_shape(
        &self,
        name: &str,
        params: &Value,
        cancel: Option<CancelToken>,
    ) -> Result<Shape, String> {
        self.call(Scope::None, super::GENERATE_BUDGET, cancel, |p, s| {
            let r = p.call_generate_shape(&mut *s, name, &params.to_string())?;
            Ok(match r {
                Ok(h) => take(s.data_mut(), h),
                Err(e) => Err(e),
            })
        })?
    }

    pub fn write_export(
        &self,
        exporter: &str,
        bodies: Vec<ExportMesh>,
        options: &Value,
        path: &Path,
        cancel: Option<CancelToken>,
    ) -> Result<Option<Value>, String> {
        let info = self.call(
            Scope::Export(path.to_path_buf()),
            super::EXPORT_BUDGET,
            cancel,
            |p, s| p.call_write_export(s, exporter, &bodies, &options.to_string()),
        )??;
        if info.trim().is_empty() {
            return Ok(None);
        }
        serde_json::from_str(&info)
            .map(Some)
            .map_err(|e| format!("the exporter's info is not JSON: {e}"))
    }

    pub fn resolve_pass(&self, pass: &str, body: &Shape, spec: &Value) -> Result<Vec<Shape>, String> {
        self.call(Scope::None, super::MESH_PASS_BUDGET, None, |p, s| {
            let h = s.data_mut().table.push(HostShape(body.clone()))?;
            let r = p.call_resolve_pass(&mut *s, pass, h, &spec.to_string())?;
            Ok(match r {
                Ok(hs) => hs.into_iter().map(|h| take(s.data_mut(), h)).collect(),
                Err(e) => Err(e),
            })
        })?
    }

    pub fn displace(
        &self,
        pass: &str,
        face: &Shape,
        triangles: MeshData,
        spec: &Value,
        density_cap: u32,
    ) -> Result<MeshData, String> {
        self.call(Scope::None, super::MESH_PASS_BUDGET, None, |p, s| {
            let h = s.data_mut().table.push(HostShape(face.clone()))?;
            p.call_displace(&mut *s, pass, h, &triangles, &spec.to_string(), density_cap)
        })?
    }
}

fn take(state: &mut State, h: Resource<HostShape>) -> Result<Shape, String> {
    state
        .table
        .delete(h)
        .map(|s| s.0)
        .map_err(|e| format!("the plugin returned a shape it does not hold: {e}"))
}

impl State {
    fn shape(&self, h: &Resource<HostShape>) -> wasmtime::Result<&Shape> {
        Ok(&self.table.get(h)?.0)
    }

    fn own(&mut self, s: Shape) -> wasmtime::Result<Resource<HostShape>> {
        Ok(self.table.push(HostShape(s))?)
    }

    fn own_all(&mut self, v: Vec<Shape>) -> wasmtime::Result<Vec<Resource<HostShape>>> {
        v.into_iter().map(|s| self.own(s)).collect()
    }

    fn made(&mut self, r: Result<Shape, String>) -> wasmtime::Result<Result<Resource<HostShape>, String>> {
        Ok(match r {
            Ok(s) => Ok(self.own(s)?),
            Err(e) => Err(e),
        })
    }

    fn feature(&mut self) -> Result<(&mut Ctx, &Value, Option<&str>), String> {
        match &self.scope {
            Scope::Feature(f) => {
                // SAFETY: see FeatureScope, the call that set it is still running.
                let ctx = unsafe { &mut *f.ctx };
                Ok((ctx, &f.raw, f.feature_id.as_deref()))
            }
            _ => Err("this is only available while a feature rebuilds".into()),
        }
    }
}

impl types::Host for State {}

impl host_api::Host for State {
    fn cancelled(&mut self) -> wasmtime::Result<bool> {
        Ok(self.cancel.as_ref().is_some_and(CancelToken::is_cancelled))
    }

    fn progress(&mut self, _fraction: f64, _message: String) -> wasmtime::Result<()> {
        Ok(())
    }

    fn log(&mut self, message: String) -> wasmtime::Result<()> {
        eprintln!("[plugin-geometry] {}", message.chars().take(2000).collect::<String>());
        Ok(())
    }
}

impl kernel::HostShape for State {
    fn kind(&mut self, s: Resource<HostShape>) -> wasmtime::Result<types::ShapeKind> {
        Ok(k::kind(self.shape(&s)?))
    }

    fn solids(&mut self, s: Resource<HostShape>) -> wasmtime::Result<Vec<Resource<HostShape>>> {
        let v = k::items(self.shape(&s)?, k::Items::Solids);
        self.own_all(v)
    }

    fn faces(&mut self, s: Resource<HostShape>) -> wasmtime::Result<Vec<Resource<HostShape>>> {
        let v = k::items(self.shape(&s)?, k::Items::Faces);
        self.own_all(v)
    }

    fn wires(&mut self, s: Resource<HostShape>) -> wasmtime::Result<Vec<Resource<HostShape>>> {
        let v = k::items(self.shape(&s)?, k::Items::Wires);
        self.own_all(v)
    }

    fn edges(&mut self, s: Resource<HostShape>) -> wasmtime::Result<Vec<Resource<HostShape>>> {
        let v = k::items(self.shape(&s)?, k::Items::Edges);
        self.own_all(v)
    }

    fn outer_wire(&mut self, s: Resource<HostShape>) -> wasmtime::Result<Option<Resource<HostShape>>> {
        match k::outer_wire(self.shape(&s)?) {
            Some(w) => Ok(Some(self.own(w)?)),
            None => Ok(None),
        }
    }

    fn inner_wires(&mut self, s: Resource<HostShape>) -> wasmtime::Result<Vec<Resource<HostShape>>> {
        let v = k::inner_wires(self.shape(&s)?);
        self.own_all(v)
    }

    fn surface(&mut self, s: Resource<HostShape>) -> wasmtime::Result<types::Surface> {
        Ok(k::surface(self.shape(&s)?))
    }

    fn curve(&mut self, s: Resource<HostShape>) -> wasmtime::Result<types::Curve> {
        Ok(k::curve(self.shape(&s)?))
    }

    fn sample_edges(&mut self, s: Resource<HostShape>, segments: u32) -> wasmtime::Result<Vec<types::Vec3>> {
        Ok(k::sample_edges(self.shape(&s)?, segments))
    }

    fn point_at(&mut self, s: Resource<HostShape>, position: f64) -> wasmtime::Result<Option<types::Vec3>> {
        Ok(k::point_at(self.shape(&s)?, position))
    }

    fn tangent_at(&mut self, s: Resource<HostShape>, position: f64) -> wasmtime::Result<Option<types::Vec3>> {
        Ok(opencascade::select_access::edge_tangent(self.shape(&s)?, position).map(k::tuple))
    }

    fn center(&mut self, s: Resource<HostShape>) -> wasmtime::Result<Option<types::Vec3>> {
        Ok(k::center(self.shape(&s)?))
    }

    fn normal_at(&mut self, s: Resource<HostShape>, point: types::Vec3) -> wasmtime::Result<Option<types::Vec3>> {
        Ok(k::normal_at(self.shape(&s)?, point))
    }

    fn classify(&mut self, s: Resource<HostShape>, point: types::Vec3, tolerance: f64) -> wasmtime::Result<types::PointState> {
        Ok(k::classify(self.shape(&s)?, point, tolerance))
    }

    fn volume(&mut self, s: Resource<HostShape>) -> wasmtime::Result<f64> {
        Ok(crate::kernel::volume(self.shape(&s)?))
    }

    fn area(&mut self, s: Resource<HostShape>) -> wasmtime::Result<f64> {
        Ok(crate::kernel::area(self.shape(&s)?))
    }

    fn bounding_box(&mut self, s: Resource<HostShape>) -> wasmtime::Result<Option<(types::Vec3, types::Vec3)>> {
        Ok(crate::kernel::bbox(self.shape(&s)?).map(|b| ((b[0], b[1], b[2]), (b[3], b[4], b[5]))))
    }

    fn is_valid(&mut self, s: Resource<HostShape>) -> wasmtime::Result<bool> {
        Ok(k::is_valid(self.shape(&s)?))
    }

    fn is_same(&mut self, s: Resource<HostShape>, other: Resource<HostShape>) -> wasmtime::Result<bool> {
        Ok(k::is_same(self.shape(&s)?, self.shape(&other)?))
    }

    fn faces_of_edge(&mut self, s: Resource<HostShape>, edge: Resource<HostShape>) -> wasmtime::Result<Vec<Resource<HostShape>>> {
        let v = k::faces_of_edge(self.shape(&s)?, self.shape(&edge)?);
        self.own_all(v)
    }

    fn dihedral_deg(&mut self, s: Resource<HostShape>, edge: Resource<HostShape>) -> wasmtime::Result<Option<f64>> {
        Ok(crate::features::blend::ops::dihedral_deg(self.shape(&s)?, self.shape(&edge)?))
    }

    fn triangulate(&mut self, s: Resource<HostShape>, deflection: f64) -> wasmtime::Result<Result<types::Mesh, String>> {
        Ok(k::triangulate(self.shape(&s)?, deflection))
    }

    fn drop(&mut self, s: Resource<HostShape>) -> wasmtime::Result<()> {
        self.table.delete(s)?;
        Ok(())
    }
}

impl kernel::Host for State {
    fn make_box(&mut self, corner: types::Vec3, size: types::Vec3) -> wasmtime::Result<Result<Resource<HostShape>, String>> {
        self.made(k::make_box(corner, size))
    }

    fn make_cylinder(&mut self, base: types::Vec3, axis: types::Vec3, radius: f64, height: f64) -> wasmtime::Result<Result<Resource<HostShape>, String>> {
        self.made(k::make_cylinder(base, axis, radius, height))
    }

    fn make_cone(&mut self, base: types::Vec3, axis: types::Vec3, r1: f64, r2: f64, height: f64) -> wasmtime::Result<Result<Resource<HostShape>, String>> {
        self.made(k::make_cone(base, axis, r1, r2, height))
    }

    fn make_sphere(&mut self, center: types::Vec3, radius: f64) -> wasmtime::Result<Result<Resource<HostShape>, String>> {
        self.made(k::make_sphere(center, radius))
    }

    fn polygon_face(&mut self, points: Vec<types::Vec3>) -> wasmtime::Result<Result<Resource<HostShape>, String>> {
        self.made(k::polygon_face(&points))
    }

    fn face_from_wire(&mut self, wire: Resource<HostShape>) -> wasmtime::Result<Result<Resource<HostShape>, String>> {
        let r = k::face_from_wire(self.shape(&wire)?);
        self.made(r)
    }

    fn sketch_faces(&mut self, plane: String, entities: String) -> wasmtime::Result<Result<Vec<Resource<HostShape>>, String>> {
        let made = match self.feature() {
            Ok((ctx, _, _)) => k::sketch_faces(Some(ctx), &plane, &entities),
            Err(_) => k::sketch_faces(None, &plane, &entities),
        };
        Ok(match made {
            Ok(v) => Ok(self.own_all(v)?),
            Err(e) => Err(e),
        })
    }

    fn prism(&mut self, profile: Resource<HostShape>, direction: types::Vec3) -> wasmtime::Result<Result<Resource<HostShape>, String>> {
        let r = k::prism(self.shape(&profile)?, direction);
        self.made(r)
    }

    fn revolve(&mut self, profile: Resource<HostShape>, origin: types::Vec3, axis: types::Vec3, degrees: f64) -> wasmtime::Result<Result<Resource<HostShape>, String>> {
        let r = k::revolve(self.shape(&profile)?, origin, axis, degrees);
        self.made(r)
    }

    fn boolean(&mut self, op: types::BooleanOp, base: Resource<HostShape>, tools: Vec<Resource<HostShape>>) -> wasmtime::Result<Result<Resource<HostShape>, String>> {
        let ts: Vec<&Shape> = tools.iter().map(|t| self.shape(t)).collect::<wasmtime::Result<_>>()?;
        let r = k::boolean(op, self.shape(&base)?, &ts);
        self.made(r)
    }

    fn unify(&mut self, s: Resource<HostShape>) -> wasmtime::Result<Resource<HostShape>> {
        let r = k::unify(self.shape(&s)?);
        self.own(r)
    }

    fn translate(&mut self, s: Resource<HostShape>, offset: types::Vec3) -> wasmtime::Result<Result<Resource<HostShape>, String>> {
        let r = k::translate(self.shape(&s)?, offset);
        self.made(r)
    }

    fn place(&mut self, s: Resource<HostShape>, origin: types::Vec3, z_axis: types::Vec3) -> wasmtime::Result<Result<Resource<HostShape>, String>> {
        let r = k::place(self.shape(&s)?, origin, z_axis);
        self.made(r)
    }

    fn compound(&mut self, parts: Vec<Resource<HostShape>>) -> wasmtime::Result<Resource<HostShape>> {
        let ps: Vec<&Shape> = parts.iter().map(|t| self.shape(t)).collect::<wasmtime::Result<_>>()?;
        let c = crate::kernel::compound(ps);
        self.own(c)
    }

    fn fillet(&mut self, s: Resource<HostShape>, edges: Vec<Resource<HostShape>>, radius: f64, one_by_one: bool) -> wasmtime::Result<Result<kernel::Blended, String>> {
        let es: Vec<Shape> = edges.iter().map(|e| self.shape(e).cloned()).collect::<wasmtime::Result<_>>()?;
        let r = k::blend(self.shape(&s)?, &es, k::Blend::Fillet(radius), one_by_one);
        self.blended(r)
    }

    fn chamfer(&mut self, s: Resource<HostShape>, edges: Vec<Resource<HostShape>>, d1: f64, d2: f64, one_by_one: bool) -> wasmtime::Result<Result<kernel::Blended, String>> {
        let es: Vec<Shape> = edges.iter().map(|e| self.shape(e).cloned()).collect::<wasmtime::Result<_>>()?;
        let r = k::blend(self.shape(&s)?, &es, k::Blend::Chamfer(d1, d2), one_by_one);
        self.blended(r)
    }

    fn read_blob(&mut self, id: String) -> wasmtime::Result<Result<Resource<HostShape>, String>> {
        self.made(k::read_blob(&id))
    }

    fn write_blob(&mut self, s: Resource<HostShape>) -> wasmtime::Result<Result<String, String>> {
        Ok(k::write_blob(self.shape(&s)?))
    }
}

impl State {
    fn blended(&mut self, r: Result<(Shape, u32), String>) -> wasmtime::Result<Result<kernel::Blended, String>> {
        Ok(match r {
            Ok((shape, skipped)) => Ok(kernel::Blended {
                shape: self.own(shape)?,
                skipped,
            }),
            Err(e) => Err(e),
        })
    }

    fn picks(
        &mut self,
        field: &str,
        label: &str,
        edges: bool,
    ) -> wasmtime::Result<Result<Vec<feature::Picked>, String>> {
        let groups = match self.feature().and_then(|(ctx, raw, fid)| pick(ctx, raw, fid, field, label, edges)) {
            Ok(g) => g,
            Err(e) => return Ok(Err(e)),
        };
        let mut out = Vec::with_capacity(groups.len());
        for (body, items) in groups {
            out.push(feature::Picked {
                body,
                items: self.own_all(items)?,
            });
        }
        Ok(Ok(out))
    }
}

fn body_index(ctx: &Ctx, body: u32) -> Result<usize, String> {
    let i = body as usize;
    if i < ctx.bodies.len() {
        Ok(i)
    } else {
        Err("the target body no longer exists".into())
    }
}

/// ptb_read.py `picked_faces`: selectors grouped by body, then resolved.
fn pick(
    ctx: &mut Ctx,
    raw: &Value,
    fid: Option<&str>,
    field: &str,
    label: &str,
    edges: bool,
) -> Result<Vec<(u32, Vec<Shape>)>, String> {
    let what = if edges { "edge" } else { "face" };
    let sel = raw.get(field).filter(|v| crate::select::entity::truthy(Some(v)));
    let Some(sel) = sel else {
        return Err(format!("{label}: pick at least one {what}"));
    };
    let typed: OneOrMany<Selector> =
        serde_json::from_value(sel.clone()).map_err(|e| format!("{label}: {e}"))?;
    let groups = crate::select::group_by_body(ctx, &typed, label).map_err(fail_text)?;
    let groups: Vec<(usize, Value)> = groups
        .into_iter()
        .map(|(b, sels)| (b, serde_json::to_value(sels).unwrap_or(Value::Null)))
        .collect();
    let mut out = Vec::new();
    for (body, sels) in groups {
        let shape = ctx.bodies[body].shape().clone();
        let name = ctx.bodies[body].name.clone();
        let mut r = crate::select::Resolver::new(Some(&mut ctx.diagnostics), fid);
        let items = if edges {
            r.edges(&shape, &sels)
        } else {
            r.faces(&shape, &sels)
        }
        .map_err(fail_text)?;
        if items.is_empty() {
            return Err(format!("{label}: the picked {what} is gone from {name}"));
        }
        out.push((body as u32, items));
    }
    Ok(out)
}

pub(super) fn fail_text(f: crate::builder::Fail) -> String {
    match f {
        crate::builder::Fail::Value { message, .. } => message,
        crate::builder::Fail::Missing(key) => format!("missing the field \"{key}\""),
        crate::builder::Fail::Internal(name) => format!("failed ({name})"),
    }
}

impl feature::Host for State {
    fn definition(&mut self) -> wasmtime::Result<String> {
        Ok(self.feature().map(|(_, raw, _)| raw.to_string()).unwrap_or_default())
    }

    fn number(&mut self, value: String) -> wasmtime::Result<Result<f64, String>> {
        Ok(self.feature().and_then(|(ctx, _, _)| {
            let v: Value = serde_json::from_str(&value).map_err(text)?;
            let n: Num = serde_json::from_value(v.clone())
                .map_err(|_| format!("could not convert {v} to a number"))?;
            ctx.val(&n).map_err(fail_text)
        }))
    }

    fn pick_faces(&mut self, field: String, label: String) -> wasmtime::Result<Result<Vec<feature::Picked>, String>> {
        self.picks(&field, &label, false)
    }

    fn pick_edges(&mut self, field: String, label: String) -> wasmtime::Result<Result<Vec<feature::Picked>, String>> {
        self.picks(&field, &label, true)
    }

    fn target_bodies(&mut self, field: String, label: String) -> wasmtime::Result<Result<Vec<u32>, String>> {
        Ok(self.feature().and_then(|(ctx, raw, _)| {
            let ids: Vec<String> = match raw.get(&field) {
                Some(Value::String(s)) => vec![s.clone()],
                Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
                _ => vec![],
            };
            if ids.is_empty() {
                return ctx.require_active(&label).map(|i| vec![i as u32]).map_err(fail_text);
            }
            ids.iter()
                .map(|id| {
                    ctx.find_body(id)
                        .map(|i| i as u32)
                        .ok_or_else(|| format!("{label}: the target body no longer exists"))
                })
                .collect()
        }))
    }

    fn body_shape(&mut self, body: u32) -> wasmtime::Result<Result<Resource<HostShape>, String>> {
        let r = self
            .feature()
            .and_then(|(ctx, _, _)| body_index(ctx, body).map(|i| ctx.bodies[i].shape().clone()));
        self.made(r)
    }

    fn body_name(&mut self, body: u32) -> wasmtime::Result<Result<String, String>> {
        Ok(self
            .feature()
            .and_then(|(ctx, _, _)| body_index(ctx, body).map(|i| ctx.bodies[i].name.clone())))
    }

    fn set_body_shape(&mut self, body: u32, s: Resource<HostShape>) -> wasmtime::Result<Result<(), String>> {
        let shape = self.shape(&s)?.clone();
        Ok(self.feature().and_then(|(ctx, _, _)| {
            let i = body_index(ctx, body)?;
            ctx.set_shape(i, shape);
            Ok(())
        }))
    }

    fn add_body(&mut self, s: Resource<HostShape>, name: Option<String>) -> wasmtime::Result<u32> {
        let shape = self.shape(&s)?.clone();
        match self.feature() {
            Ok((ctx, _, _)) => Ok(ctx.new_body(shape, name, None) as u32),
            Err(e) => Err(wasmtime::Error::msg(e)),
        }
    }

    fn diagnostic(&mut self, entry: String) -> wasmtime::Result<()> {
        if let Ok((ctx, _, fid)) = self.feature() {
            if let Ok(Value::Object(mut m)) = serde_json::from_str::<Value>(&entry) {
                m.insert("feature_id".into(), fid.map_or(Value::Null, |f| Value::String(f.into())));
                ctx.diagnostics.push(Value::Object(m));
            }
        }
        Ok(())
    }

    fn stash_pass(&mut self, body: u32, spec: String) -> wasmtime::Result<Result<(), String>> {
        Ok(self.feature().and_then(|(ctx, _, _)| {
            let i = body_index(ctx, body)?;
            let v: Value = serde_json::from_str(&spec).map_err(text)?;
            if v.get("pass").and_then(Value::as_str).is_none() {
                return Err("a mesh pass spec needs a \"pass\" name".into());
            }
            ctx.bodies[i].mesh_passes.push(v);
            Ok(())
        }))
    }
}

impl output::Host for State {
    fn write(&mut self, bytes: Vec<u8>) -> wasmtime::Result<Result<(), String>> {
        let Scope::Export(path) = &self.scope else {
            return Ok(Err("only an exporter can write a file".into()));
        };
        use std::io::Write;
        let r = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut f| f.write_all(&bytes));
        Ok(r.map_err(text))
    }
}
