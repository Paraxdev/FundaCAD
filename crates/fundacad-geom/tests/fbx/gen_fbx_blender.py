"""Writes tests/fixtures/fbx_blender_two.fbx, binary FBX 7.4 in centimetres, with Blender's own exporter.

    blender -b --factory-startup -P crates/fundacad-geom/tests/fbx/gen_fbx_blender.py

Left   a 20 mm cube on the floor at the origin, material Red
Right  a 20 mm cube 50 mm along X turned 30 degrees about Z, material Blue
Top    a 10 mm cube, child of Right, 30 mm above it in Right's frame, no material
plus one camera and one point light, which the import skips.
"""
import math
import os

import bpy

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "tests", "fixtures", "fbx_blender_two.fbx")

bpy.ops.wm.read_factory_settings(use_empty=True)


def mat(name, rgb):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1.0)
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*rgb, 1.0)
    return m


# Blender scenes are in metres.
bpy.ops.mesh.primitive_cube_add(size=0.02, location=(0, 0, 0.01))
a = bpy.context.object
a.name = "Left"
a.data.materials.append(mat("Red", (1, 0, 0)))
bpy.ops.mesh.primitive_cube_add(size=0.02, location=(0.05, 0, 0.01), rotation=(0, 0, math.radians(30)))
b = bpy.context.object
b.name = "Right"
b.data.materials.append(mat("Blue", (0, 0, 1)))
bpy.ops.mesh.primitive_cube_add(size=0.01, location=(0, 0, 0.03))
c = bpy.context.object
c.name = "Top"
c.parent = b
bpy.ops.object.camera_add(location=(1, -1, 1))
bpy.ops.object.light_add(type="POINT", location=(0, 0, 2))
bpy.ops.export_scene.fbx(filepath=os.path.abspath(OUT), use_selection=False, object_types={"MESH", "CAMERA", "LIGHT"})
