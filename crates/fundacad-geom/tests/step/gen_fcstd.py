"""Writes tests/fixtures/plate.FCStd and bracket.FCStd, the files
tests/import_fcstd.rs reads. Needs FreeCAD 1.x:

    freecadcmd gen_fcstd.py <repo>/tests/fixtures

plate: a Part::Cut of a box and a cylinder, both hidden by the cut, and a ball.
bracket: a PartDesign body padded from a sketch inside an App::Part moved
100 mm along x, the body and its pad both visible with the same shape.
"""
import os
import sys

import FreeCAD as App
import Part

d = sys.argv[-1]

doc = App.newDocument("fx")
b = doc.addObject("Part::Box", "Box")
b.Label, b.Length, b.Width, b.Height = "Plate", 40, 20, 5
c = doc.addObject("Part::Cylinder", "Cyl")
c.Label, c.Radius, c.Height = "Hole tool", 4, 10
c.Placement.Base = App.Vector(20, 10, -2)
cut = doc.addObject("Part::Cut", "Cut")
cut.Label, cut.Base, cut.Tool = "Plate with hole", b, c
s = doc.addObject("Part::Sphere", "Sph")
s.Label, s.Radius = "Ball", 5
s.Placement.Base = App.Vector(60, 0, 5)
doc.recompute()
b.Visibility = False
c.Visibility = False
doc.saveAs(os.path.join(d, "plate.FCStd"))

doc = App.newDocument("pd")
part = doc.addObject("App::Part", "Part")
part.Label = "Assembly"
part.Placement.Base = App.Vector(100, 0, 0)
body = doc.addObject("PartDesign::Body", "Body")
body.Label = "Bracket"
part.addObject(body)
sk = body.newObject("Sketcher::SketchObject", "Sketch")
sk.AttachmentSupport = (body.Origin.OriginFeatures[3], [""])
sk.MapMode = "FlatFace"
pts = [App.Vector(0, 0, 0), App.Vector(30, 0, 0), App.Vector(30, 10, 0), App.Vector(0, 10, 0)]
for i in range(4):
    sk.addGeometry(Part.LineSegment(pts[i], pts[(i + 1) % 4]))
pad = body.newObject("PartDesign::Pad", "Pad")
pad.Profile, pad.Length = sk, 8
doc.recompute()
sk.Visibility = True
doc.saveAs(os.path.join(d, "bracket.FCStd"))
