wit_bindgen::generate!({
    world: "plugin",
    path: "../../../crates/fundacad-geom/wit",
});

struct Toolbox;

impl Guest for Toolbox {
    fn register() -> Registration {
        Registration { features: vec![], mesh_passes: vec![], exporters: vec![], shape_generators: vec![] }
    }
    fn run_feature(_t: String) -> Result<(), String> { Ok(()) }
    fn resolve_pass(_p: String, _b: &Shape, _s: String) -> Result<Vec<Shape>, String> { Err("no".into()) }
    fn displace(_p: String, _f: &Shape, _m: Mesh, _s: String, _c: u32) -> Result<Mesh, String> { Err("no".into()) }
    fn write_export(_e: String, _b: Vec<ExportBody>, _o: String) -> Result<String, String> { Err("no".into()) }
    fn generate_shape(_g: String, _p: String) -> Result<Shape, String> { Err("no".into()) }
}

export!(Toolbox);
