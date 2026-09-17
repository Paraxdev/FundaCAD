"""What this plugin adds to the geometry engine: one shape generator, and no feature type.

A fastener is generated once, when it is inserted, and stored in the document as an `import`
feature's blob (sidecar/shape_generate.py). So nothing here is needed to open or rebuild a document
that has fasteners in it.
"""

from scr_build import build

GENERATOR = "fastener"


def register(engine, plugin_id):
    engine.register_shape_generator(GENERATOR, plugin_id, build)
