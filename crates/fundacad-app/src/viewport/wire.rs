//! World space line lists drawn in the model's depth: the wireframe's body edges, and the pipeline any other line
//! overlay can draw with (one colour per draw, from the `edge` uniform).

#[cfg(test)]
mod tests;

use fundacad_client::Body;
use gpui_wgpu::wgpu;

use super::edges::polylines;

/// Every edge of the body as line list ends, two points per segment.
pub fn segments(body: &Body) -> Vec<[f32; 3]> {
    let mut out = Vec::new();
    for line in polylines(body) {
        for w in line.windows(2) {
            out.push(w[0].into());
            out.push(w[1].into());
        }
    }
    out
}

pub(super) fn pipeline(
    device: &wgpu::Device,
    layout: &wgpu::PipelineLayout,
    shader: &wgpu::ShaderModule,
    format: wgpu::TextureFormat,
    depth: wgpu::DepthStencilState,
    samples: u32,
) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("viewport lines"),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vs_line"),
            compilation_options: Default::default(),
            buffers: &[Some(wgpu::VertexBufferLayout {
                array_stride: 12,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &wgpu::vertex_attr_array![0 => Float32x3],
            })],
        },
        primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::LineList, ..Default::default() },
        depth_stencil: Some(depth),
        multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some("fs_line"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    })
}
