//! The page's traced material (materials.ts traceMaterialFrom, the P3 mapping) packed for the GPU. A baked procedural
//! slot arrives white from the mirror, its roughness offset applied and its colour in the vertex colours.

use serde::Deserialize;

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PageMaterial {
    pub color: Option<[f32; 3]>,
    pub emissive: Option<[f32; 3]>,
    pub emissive_intensity: Option<f32>,
    pub metalness: Option<f32>,
    pub roughness: Option<f32>,
    pub transmission: Option<f32>,
    pub ior: Option<f32>,
    pub attenuation_color: Option<[f32; 3]>,
    pub attenuation_distance: Option<f32>,
    pub dispersion: Option<f32>,
    pub specular_color: Option<[f32; 3]>,
    pub specular_intensity: Option<f32>,
    pub sheen: Option<f32>,
    pub sheen_color: Option<[f32; 3]>,
    pub sheen_roughness: Option<f32>,
    pub clearcoat: Option<f32>,
    pub clearcoat_roughness: Option<f32>,
    pub opacity: Option<f32>,
    pub vertex_colors: bool,
    /// Glows to the camera and is left out of the light table.
    pub no_light: bool,
}

pub const FLAG_SOLID: u32 = 1;
pub const FLAG_VERTEX_COLORS: u32 = 2;
/// An emitter left out of the light table, the page's userData.noLight.
pub const FLAG_NO_LIGHT: u32 = 4;

/// Nine vec4s, 144 bytes, the layout the shader's `Mat` struct reads.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GpuMaterial {
    /// rgb, opacity
    pub base: [f32; 4],
    /// rgb already times intensity, w = flags as bits
    pub emission: [f32; 4],
    /// metalness, roughness, transmission, ior
    pub pbr: [f32; 4],
    /// rgb, distance (f32::INFINITY when it does not absorb)
    pub attenuation: [f32; 4],
    /// clearcoat, clearcoat roughness, dispersion, specular intensity
    pub coat: [f32; 4],
    /// specular colour rgb, sheen
    pub specular: [f32; 4],
    /// sheen colour rgb, sheen roughness
    pub sheen: [f32; 4],
    /// iridescence, iridescence ior, thickness min nm, thickness max nm
    pub film: [f32; 4],
    /// anisotropy, scatter distance mm, flakes, flake size mm
    pub finish: [f32; 4],
}

impl GpuMaterial {
    pub fn flags(&self) -> u32 {
        self.emission[3].to_bits()
    }
    pub fn emits(&self) -> bool {
        self.emission[..3].iter().any(|c| *c > 0.0)
    }
    /// The luminance its triangles enter the light table with, 0 for none.
    pub fn light_power(&self) -> f32 {
        if self.flags() & FLAG_NO_LIGHT != 0 {
            return 0.0;
        }
        (0.2126 * self.emission[0] + 0.7152 * self.emission[1] + 0.0722 * self.emission[2]).max(0.0)
    }
    /// The shader's albedo: the base colour times the interpolated vertex
    /// colour when the body carries paint or a bake.
    pub fn albedo(&self, vertex: Option<[f32; 3]>) -> [f32; 3] {
        let v = match vertex {
            Some(v) if self.flags() & FLAG_VERTEX_COLORS != 0 => v,
            _ => [1.0; 3],
        };
        [self.base[0] * v[0], self.base[1] * v[1], self.base[2] * v[2]]
    }
}

pub fn pack_material(m: &PageMaterial) -> GpuMaterial {
    let color = m.color.unwrap_or([1.0; 3]);
    let k = m.emissive_intensity.unwrap_or(1.0);
    let e = m.emissive.unwrap_or([0.0; 3]).map(|c| c * k);
    let transmission = m.transmission.unwrap_or(0.0);
    let mut flags = 0;
    if transmission > 0.0 {
        flags |= FLAG_SOLID;
    }
    if m.vertex_colors {
        flags |= FLAG_VERTEX_COLORS;
    }
    if m.no_light {
        flags |= FLAG_NO_LIGHT;
    }
    let dist = match m.attenuation_distance {
        Some(d) if d > 0.0 => d,
        _ => f32::INFINITY,
    };
    let att = m.attenuation_color.unwrap_or([1.0; 3]);
    let spec = m.specular_color.unwrap_or([1.0; 3]);
    let sheen = m.sheen_color.unwrap_or([0.0; 3]);
    GpuMaterial {
        base: [color[0], color[1], color[2], m.opacity.unwrap_or(1.0)],
        emission: [e[0], e[1], e[2], f32::from_bits(flags)],
        pbr: [m.metalness.unwrap_or(0.0), m.roughness.unwrap_or(0.5), transmission, m.ior.unwrap_or(1.5)],
        attenuation: [att[0], att[1], att[2], dist],
        coat: [
            m.clearcoat.unwrap_or(0.0),
            m.clearcoat_roughness.unwrap_or(0.0),
            m.dispersion.unwrap_or(0.0),
            m.specular_intensity.unwrap_or(1.0),
        ],
        specular: [spec[0], spec[1], spec[2], m.sheen.unwrap_or(0.0)],
        sheen: [sheen[0], sheen[1], sheen[2], m.sheen_roughness.unwrap_or(1.0)],
        film: [0.0; 4],
        finish: [0.0; 4],
    }
}

/// A three.js geometry group: `start` and `count` count indices.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
pub struct Group {
    pub start: u32,
    pub count: u32,
    pub slot: u32,
}

/// The material slot of every triangle; one not inside a group takes slot 0
/// like three draws it with the first material.
pub fn tri_slots(groups: &[Group], tri_count: usize) -> Vec<u32> {
    let mut out = vec![0; tri_count];
    for g in groups {
        let lo = (g.start / 3) as usize;
        let hi = ((g.start + g.count) / 3) as usize;
        for s in out.iter_mut().take(hi.min(tri_count)).skip(lo) {
            *s = g.slot;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(j: &str) -> GpuMaterial {
        pack_material(&serde_json::from_str(j).unwrap())
    }

    #[test]
    fn the_pack_is_nine_vec4_with_film_and_finish_zero() {
        assert_eq!(std::mem::size_of::<GpuMaterial>(), 144);
        let m = parse(r#"{"color":[0.2,0.3,0.4],"transmission":1,"sheen":0.5}"#);
        assert_eq!(m.film, [0.0; 4]);
        assert_eq!(m.finish, [0.0; 4]);
        assert_eq!(m.flags() & FLAG_NO_LIGHT, 0);
    }

    #[test]
    fn defaults_follow_trace_material_from() {
        let m = parse("{}");
        assert_eq!(m.base, [1.0, 1.0, 1.0, 1.0]);
        assert_eq!(m.pbr, [0.0, 0.5, 0.0, 1.5]);
        assert_eq!(m.attenuation[3], f32::INFINITY);
        assert_eq!(m.coat, [0.0, 0.0, 0.0, 1.0]);
        assert_eq!(m.flags(), 0);
        assert!(!m.emits());
    }

    #[test]
    fn transmission_makes_a_solid_and_zero_distance_does_not_absorb() {
        let m = parse(r#"{"transmission":1,"ior":1.45,"attenuationDistance":0,"attenuationColor":[0.2,0.5,0.9]}"#);
        assert_eq!(m.flags() & FLAG_SOLID, FLAG_SOLID);
        assert_eq!(m.attenuation, [0.2, 0.5, 0.9, f32::INFINITY]);
        assert_eq!(m.pbr[3], 1.45);
        assert_eq!(parse(r#"{"attenuationDistance":12}"#).attenuation[3], 12.0);
        assert_eq!(parse(r#"{"transmission":0}"#).flags() & FLAG_SOLID, 0);
    }

    #[test]
    fn emission_is_colour_times_intensity_and_black_does_not_emit() {
        let m = parse(r#"{"emissive":[1,0.5,0],"emissiveIntensity":3}"#);
        assert_eq!(&m.emission[..3], &[3.0, 1.5, 0.0]);
        assert!(m.emits());
        assert!(!parse(r#"{"emissive":[0,0,0],"emissiveIntensity":5}"#).emits());
    }

    #[test]
    fn no_light_keeps_the_glow_out_of_the_light_table() {
        let m = parse(r#"{"emissive":[1,1,1],"emissiveIntensity":2,"noLight":true}"#);
        assert_eq!(m.flags() & FLAG_NO_LIGHT, FLAG_NO_LIGHT);
        assert!(m.emits());
        assert_eq!(m.light_power(), 0.0);
        assert!((parse(r#"{"emissive":[1,1,1],"emissiveIntensity":2}"#).light_power() - 2.0).abs() < 1e-5);
    }

    #[test]
    fn finish_table() {
        // (finish, json, metalness, roughness, transmission, clearcoat, clearcoat roughness, dispersion)
        let rows = [
            ("matte", r#"{"color":[0.8,0.8,0.8],"roughness":0.9}"#, 0.0, 0.9, 0.0, 0.0, 0.0, 0.0),
            ("metal", r#"{"metalness":1,"roughness":0.2}"#, 1.0, 0.2, 0.0, 0.0, 0.0, 0.0),
            ("glass", r#"{"transmission":1,"roughness":0,"ior":1.5,"dispersion":0.3}"#, 0.0, 0.0, 1.0, 0.0, 0.0, 0.3),
            (
                "car paint",
                r#"{"metalness":0.6,"roughness":0.4,"clearcoat":1,"clearcoatRoughness":0.05}"#,
                0.6,
                0.4,
                0.0,
                1.0,
                0.05,
                0.0,
            ),
        ];
        for (name, j, me, ro, tr, cc, ccr, di) in rows {
            let m = parse(j);
            assert_eq!([m.pbr[0], m.pbr[1], m.pbr[2]], [me, ro, tr], "{name}");
            assert_eq!([m.coat[0], m.coat[1], m.coat[2]], [cc, ccr, di], "{name}");
        }
    }

    #[test]
    fn face_groups_give_per_triangle_slots() {
        let g = [Group { start: 0, count: 6, slot: 0 }, Group { start: 6, count: 3, slot: 2 }];
        assert_eq!(tri_slots(&g, 3), vec![0, 0, 2]);
        assert_eq!(tri_slots(&[], 2), vec![0, 0]);
    }

    #[test]
    fn a_baked_slot_takes_the_vertex_colour_not_the_base_colour() {
        // The mirror whitens a baked slot's material (mirror.ts refreshMirrorMaterials).
        let baked = parse(r#"{"color":[1,1,1],"vertexColors":true}"#);
        assert_eq!(baked.albedo(Some([0.3, 0.6, 0.1])), [0.3, 0.6, 0.1]);
        let plain = parse(r#"{"color":[0.5,0.5,0.5]}"#);
        assert_eq!(plain.albedo(Some([0.3, 0.6, 0.1])), [0.5, 0.5, 0.5]);
    }
}
