//! ptb_zip.py: a U-shaped tunnel under a flat face for a zip tie.

use crate::g::{self, py_g, V};
use crate::read::{picked_faces, plane_of};
use crate::{feature, F};

pub fn zip_tie_channel(f: &F) -> Result<(), String> {
    let label = "Zip-tie channel";
    let width = f.num("channelWidth", 4.0)?;
    if width <= 0.0 {
        return Err(format!("{label}: the channel width must be greater than 0 (got {})", py_g(width)));
    }
    let height = f.num("channelHeight", 2.0)?;
    if height <= 0.0 {
        return Err(format!("{label}: the channel height must be greater than 0 (got {})", py_g(height)));
    }
    let inset = f.num("insetDepth", 2.0)?;
    if inset <= 0.0 {
        return Err(format!("{label}: the inset depth must be greater than 0 (got {})", py_g(inset)));
    }
    let span = f.num("span", 10.0)?;
    if span <= height {
        return Err(format!(
            "{label}: the span must be greater than the channel height (got span {}, height {})",
            py_g(span),
            py_g(height)
        ));
    }
    let angle = f.num("angle", 0.0)?.to_radians();
    let allow_breakthrough = f.flag("allowBreakthrough");

    let mut staged = Vec::new();
    for (body, shape, faces) in picked_faces(label)? {
        let mut tools = Vec::new();
        for fc in &faces {
            let Some((n, _)) = plane_of(fc) else {
                return Err(format!("{label}: pick a flat face for the zip-tie channel"));
            };
            let center = fc.center().ok_or_else(|| format!("{label}: the picked face has no centre"))?;
            let inward = g::mul(n, -1.0);
            let (along, across) = g::perp_frame_rotated(n, angle);
            let rect = |c: V, half_along: f64| -> Vec<V> {
                vec![
                    g::lin(c, &[(-half_along, along), (-width / 2.0, across)]),
                    g::lin(c, &[(half_along, along), (-width / 2.0, across)]),
                    g::lin(c, &[(half_along, along), (width / 2.0, across)]),
                    g::lin(c, &[(-half_along, along), (width / 2.0, across)]),
                ]
            };

            let half_h = height / 2.0;
            for sgn in [-1.0, 1.0] {
                let c = g::lin(center, &[(sgn * span / 2.0, along)]);
                tools.push(g::prism(&rect(c, half_h), g::mul(inward, inset))?);
            }

            let tl = (span - height) / 2.0;
            let deep: Vec<V> = rect(center, tl)
                .into_iter()
                .map(|p| g::lin(p, &[(inset - height, inward)]))
                .collect();
            tools.push(g::prism(&deep, g::mul(inward, height))?);

            if !allow_breakthrough {
                let probe = (0.05 * width).max(0.01);
                for along_off in [0.0, -span / 2.0, span / 2.0] {
                    let p = g::lin(center, &[(along_off, along), (inset + probe, inward)]);
                    if !g::inside(&shape, p) {
                        return Err(format!(
                            "{label}: the channel would break through the part's far side; reduce the inset depth or allow breakthrough"
                        ));
                    }
                }
            }
        }
        staged.push((body, g::cut(&shape, &tools, label)?));
    }
    for (body, out) in staged {
        feature::set_body_shape(body, &out)?;
    }
    Ok(())
}
