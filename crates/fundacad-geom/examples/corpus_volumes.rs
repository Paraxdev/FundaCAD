//! Kernel volume, face and solid count per body for one corpus document. diff_engines.py compares only mesh
//! volume, which cannot tell two glued solids from one merged solid, so run this when a volume looks wrong.

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
    let corpus: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("corpus")).expect("json");
    let raw = corpus["documents"]
        .as_array()
        .expect("documents")
        .iter()
        .find(|d| d["name"] == name.as_str())
        .map(|d| d["document"].clone())
        .expect("a document of that name");
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("the document types");
    let r = builder::rebuild(&doc, &raw, &NoWatch).ok().expect("not cancelled");
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
