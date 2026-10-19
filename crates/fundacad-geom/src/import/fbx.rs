//! FBX (Maya, 3ds Max, Blender), binary and ASCII, 6.x and 7.x, read with
//! ufbx. Every node that carries a mesh becomes one object with its world
//! transform baked in, converted to millimetres and Z up by the loader.

use ufbx::{CoordinateAxes, CoordinateAxis, LoadOpts, Material, Mesh, Node, SpaceConversion};

use super::mesh::{self, MeshObject};

pub fn read_fbx(data: &[u8]) -> Result<(Vec<MeshObject>, Vec<String>), String> {
    let opts = LoadOpts {
        target_axes: CoordinateAxes {
            right: CoordinateAxis::PositiveX,
            up: CoordinateAxis::PositiveZ,
            front: CoordinateAxis::NegativeY,
        },
        target_unit_meters: 0.001,
        space_conversion: SpaceConversion::TransformRoot,
        ignore_animation: true,
        ignore_embedded: true,
        ..Default::default()
    };
    let scene = ufbx::load_memory(data, opts).map_err(|e| format!("couldn't read this FBX file ({})", e.description.as_ref() as &str))?;

    // An instanced mesh is baked once per node that places it.
    let total: u64 = scene.nodes.iter().filter_map(|n| n.mesh.as_ref()).map(|m| m.num_triangles as u64).sum();
    if total > super::scan::MAX_SCAN_TRIANGLES {
        return Err(super::scan::too_dense_for_a_scan(total));
    }

    let mut objs = Vec::new();
    for node in scene.nodes.iter() {
        let Some(m) = node.mesh.as_ref() else { continue };
        let mirrored = ufbx::matrix_determinant(&node.geometry_to_world) < 0.0;
        let mut tri = vec![0u32; m.max_face_triangles * 3];
        let pos: Vec<f64> = m
            .vertices
            .iter()
            .flat_map(|&v| {
                let p = ufbx::transform_position(&node.geometry_to_world, v);
                [p.x, p.y, p.z]
            })
            .collect();
        let mut idx = Vec::with_capacity(m.num_triangles * 3);
        for face in m.faces.iter() {
            let n = m.triangulate_face(&mut tri, *face) as usize;
            for t in tri[..n * 3].chunks_exact(3) {
                let order = if mirrored { [t[0], t[2], t[1]] } else { [t[0], t[1], t[2]] };
                idx.extend(order.map(|ix| m.vertex_indices[ix as usize]));
            }
        }
        let name = Some(node.element.name.to_string()).filter(|s| !s.is_empty());
        objs.push(MeshObject { name, color: material(node, m).and_then(diffuse), pos, idx });
    }

    let mut notes = Vec::new();
    let skipped: Vec<String> = [
        (scene.cameras.len(), "camera", "cameras"),
        (scene.lights.len(), "light", "lights"),
        (scene.bones.len(), "bone", "bones"),
        (scene.anim_stacks.len(), "animation", "animations"),
    ]
    .into_iter()
    .filter(|&(n, ..)| n > 0)
    .map(|(n, one, many)| format!("{n} {}", if n == 1 { one } else { many }))
    .collect();
    if !skipped.is_empty() {
        let total: usize = scene.cameras.len() + scene.lights.len() + scene.bones.len() + scene.anim_stacks.len();
        let list = match skipped.split_last() {
            Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
            _ => skipped[0].clone(),
        };
        notes.push(format!("{list} {} skipped, only meshes are read", if total == 1 { "was" } else { "were" }));
    }
    Ok((objs, notes))
}

/// The material most faces use. Materials hang off the node in FBX, so the
/// node's list is preferred over the mesh's, which holds the first instance's.
fn material<'a>(node: &'a Node, m: &'a Mesh) -> Option<&'a Material> {
    let list = if node.materials.is_empty() { &m.materials } else { &node.materials };
    let mut count = vec![0usize; list.len()];
    for &f in m.face_material.iter() {
        if let Some(c) = count.get_mut(f as usize) {
            *c += 1;
        }
    }
    let best = count.iter().enumerate().max_by_key(|&(i, &c)| (c, std::cmp::Reverse(i))).map_or(0, |(i, _)| i);
    list.get(best).map(|r| &**r)
}

fn diffuse(mat: &Material) -> Option<[u8; 3]> {
    let map = if mat.fbx.diffuse_color.has_value { &mat.fbx.diffuse_color } else { &mat.pbr.base_color };
    map.has_value.then(|| {
        let c = map.value_vec4;
        mesh::unit_color([c.x, c.y, c.z])
    })
}
