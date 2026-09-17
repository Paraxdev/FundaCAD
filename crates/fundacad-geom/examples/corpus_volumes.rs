//! Kernel volume, face count and solid count per body for one corpus document.
//!
//!   cargo run -p fundacad-geom --example corpus_volumes -- <corpus.json> <name>
//!
//! diff_engines.py compares the MESH volume, which is the same number a body of
//! two glued solids and a body of one merged solid report. The solid count is
//! what tells those two apart, so this is the first thing to run when the
//! harness says a volume is wrong and the picture looks nearly right.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::kernel::{self, Kind};
use fundacad_geom::measure;
use serde_json::Value;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [path, name] = &args[..] else {
        eprintln!("usage: corpus_volumes <corpus.json> <document name>");
        std::process::exit(2);
    };
    let corpus: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("corpus")).expect("json");
    let raw = corpus["documents"]
        .as_array()
        .expect("documents")
        .iter()
        .find(|d| d["name"] == name.as_str())
        .map(|d| d["document"].clone())
        .expect("a document of that name");
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("the document types");
    let r = builder::rebuild(&doc, &raw, &NoWatch)
        .ok()
        .expect("not cancelled");
    for b in &r.bodies {
        println!(
            "{} {} vol {:.4} faces {} solids {}",
            b.id,
            b.name,
            measure::volume(&b.shape),
            kernel::count(&b.shape, Kind::Face),
            kernel::count(&b.shape, Kind::Solid),
        );
    }
    for e in &r.errors {
        println!("error {:?} {}", e.feature_id, e.message);
    }
}
