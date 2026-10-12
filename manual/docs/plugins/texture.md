# Surface Texture

Surface Texture puts a pattern on a face or a whole body, such as the knurling on a knob, ribs on a grip or a leathery finish on a case. The pattern is real shape and not paint. The surface is displaced, so what you see in the viewport is what your slicer receives. For a look that exists only on screen, use the surface patterns on the [Materials and rendering](../render/materials.md) page.

The plugin is on by default. Its tool is Texture, under Modify on the rail, and the rail also offers it when you select a face or a body.

## Adding a texture

Say you want a grippy knob. Select the cylindrical face around its edge and pick Texture. A panel opens with two buttons at the top: Faces textures only the faces you selected, and Whole Body covers the entire body. Open the Kind list and pick Knurl, set a small Depth, and watch the preview change. When you like it, press Add.

<!-- shot: texture-knurl | A cylindrical knob with a knurl texture on its side and the Texture panel open beside it -->

The preview is real geometry, worked out the same way as the final build, so it trails the slider by about half a second.

A texture is a step in the History like any other. Double-click it to reopen the panel, which then shows Apply in place of Add. Delete the step to get the smooth surface back.

## Patterns and settings

Kind lists the patterns in groups. The geometric ones are Knurl, Hex, Waves, Ribs, Stripes, Grid, Dots, Brick, Isogrid, Basket weave and Carbon fibre. Voronoi, Perlin noise and Leather are the organic ones, and Grip is there for anything a hand has to hold.

Heightmap is the odd one out. It reads a picture from your computer and turns its brightness into height. Press Browse to choose the image, which is the only file the plugin ever reads.

Depth is how far the pattern rises or sinks, and Scale is how large its features are. Angle turns patterns that have a direction, like ribs and stripes. Direction chooses Out (emboss), In (deboss) or Both, and Profile switches between a Faceted, hard-edged surface and a Smooth one.

Seed gives a random pattern a different arrangement, and Randomize picks one for you. Soften blurs the pattern a little, and Invert flips high and low. Grime lets the pattern fade out onto the neighbouring faces, like wear that crept over the edge.

On curved faces that are not plain cylinders or cones, Projection decides how the pattern is laid across the curve. Triplanar keeps one size across the curve, Box favours the nearest axis, and Planar projects from one direction.

With the [Multi-material](multicolor.md) plugin on, Print color lets the texture print in a different filament slot from the body.

A heavy texture can make the model slow. Under Advanced, Mesh mm sets how fine the sampling is and Max tris caps the triangles per face, so make the mesh coarser or set a cap. Advanced also has Edge blend, which fades the pattern out towards the edge of a face, and Slope, which keeps the texture only on surfaces within a range of angles, such as vertical walls.

## If you switch it off

The file opens and every value is kept, but the textures stop building. A textured body builds smooth, and the texture's step in the History turns red and says that Surface Texture is not running. Switch the plugin back on and the same file builds as before.
