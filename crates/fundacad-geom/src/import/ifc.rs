//! IFC building models (IFC2X3, IFC4, IFC4X3): ifc-lite tessellates every
//! product with its openings cut, each product becomes one named, coloured
//! body. Openings and spaces are left out, they are not material.

use std::collections::BTreeMap;

use ifc_lite_core::IfcType;
use ifc_lite_processing::{default_color_for_type, process_geometry, MeshData};

use super::mesh::{dominant_color, unit_color, MeshObject, MAX_IMPORT_TRIANGLES};

const NOT_MATERIAL: [&str; 2] = ["IfcOpeningElement", "IfcSpace"];

pub fn read_ifc(data: &[u8]) -> Result<Vec<MeshObject>, String> {
    if data.starts_with(b"PK") {
        return Err("this is a zipped IFC (IFCZIP). Unzip it and import the .ifc file inside.".into());
    }
    let head = String::from_utf8_lossy(&data[..data.len().min(64)]);
    if !head.trim_start_matches('\u{feff}').trim_start().starts_with("ISO-10303-21") {
        return Err("this is not an IFC file, it does not start with the ISO-10303-21 header".into());
    }
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| process_geometry(data)))
        .map_err(|_| "couldn't read this IFC file, its geometry could not be tessellated".to_string())?;

    let mut products: BTreeMap<u32, Vec<&MeshData>> = BTreeMap::new();
    for m in &result.meshes {
        if NOT_MATERIAL.contains(&m.ifc_type.as_str()) || m.indices.len() < 3 {
            continue;
        }
        products.entry(m.express_id).or_default().push(m);
    }
    if products.is_empty() {
        return Err("no building elements with geometry found in this IFC file".into());
    }
    let ntri: usize = products.values().flatten().map(|m| m.indices.len() / 3).sum();
    if ntri as u64 > MAX_IMPORT_TRIANGLES {
        return Err(format!(
            "This building has {ntri} triangles, too many to import as editable bodies (limit {MAX_IMPORT_TRIANGLES}). \
             Export a storey or a selection from the BIM tool and import that."
        ));
    }

    let mut objs = Vec::with_capacity(products.len());
    for pieces in products.values() {
        let first = pieces[0];
        let mut o = MeshObject {
            name: first.name.clone().filter(|n| !n.trim().is_empty()).or_else(|| Some(first.ifc_type.clone())),
            ..MeshObject::default()
        };
        for m in pieces {
            let base = (o.pos.len() / 3) as u32;
            o.pos.extend(m.positions.chunks_exact(3).flat_map(|p| {
                [0, 1, 2].map(|k| (m.origin[k] + f64::from(p[k])) * 1000.0)
            }));
            o.idx.extend(m.indices[..m.indices.len() / 3 * 3].iter().map(|&i| base + i));
        }
        let rgb = |c: [f32; 4]| unit_color([f64::from(c[0]), f64::from(c[1]), f64::from(c[2])]);
        // ifc-lite paints an unstyled product with a stock colour of its type,
        // which is not the author's, so that colour is dropped.
        let stock = rgb(default_color_for_type(IfcType::from_str(&first.ifc_type)).0);
        o.color = dominant_color(pieces.iter().flat_map(|m| std::iter::repeat_n(Some(rgb(m.color)), m.indices.len() / 3)))
            .filter(|&c| c != stock);
        objs.push(o);
    }
    Ok(objs)
}
