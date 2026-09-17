"""The feature types this plugin builds, claimed from the geometry engine at startup.

Every tool here is a plain rebuild-time handler that edits the body's exact B-rep, so a later
fillet or boolean sees the reshaped hole. A new tool adds its handler to FEATURES and its type to
manifest.json's featureTypes.
"""

from ptb_edges import handle_elephant_foot_chamfer, handle_vertical_fillet
from ptb_holes import handle_roof_bridge, handle_teardrop
from ptb_layers import handle_counterbore_bridge, handle_sacrificial_layer
from ptb_ribs import handle_thread_ribs
from ptb_zip import handle_zip_tie_channel

FEATURES = {
    "teardropHole": handle_teardrop,
    "roofBridge": handle_roof_bridge,
    "counterboreBridge": handle_counterbore_bridge,
    "sacrificialLayer": handle_sacrificial_layer,
    "threadRibs": handle_thread_ribs,
    "zipTieChannel": handle_zip_tie_channel,
    "elephantFootChamfer": handle_elephant_foot_chamfer,
    "verticalFillet": handle_vertical_fillet,
}


def register(engine, plugin_id):
    for type_name, handler in FEATURES.items():
        engine.register_feature(type_name, plugin_id, handler)
