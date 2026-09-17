"""What this plugin adds to the geometry engine: the slicer project 3MF.

The engine rebuilds, meshes and budgets; this decides what the file looks like.
Everything that knows what a slicer project is, is in this directory.
"""

import print_presets
from print_project3mf import sanitize_inputs, write_project_3mf

EXPORTER = "print-project-3mf"

#: The settings a project carries when no slicer presets could be read: the
#: minimal keys Orca needs to pick the machine on "open as project".
BASE_SETTINGS = {
    "printer_model": "Snapmaker U1",
    "printer_variant": "0.4",
    "version": "2.4.0.0",
}


def export_project(bodies, path, options):
    """options: {palette, bodyColors, bodyNames, settings?, presets?: {datadir,
    filamentCount}}. With `presets`, the user's slicer presets are flattened into
    the project; failing that is not an error, the project still carries the
    colours, and `info.presets` says which happened."""
    palette, body_colors, body_names = sanitize_inputs(
        options.get("palette"), options.get("bodyColors"), options.get("bodyNames"))
    settings = dict(BASE_SETTINGS)
    extra = options.get("settings")
    if isinstance(extra, dict):
        settings.update(extra)

    info = {}
    presets = options.get("presets")
    if isinstance(presets, dict):
        try:
            settings.update(print_presets.project_settings(
                presets.get("datadir"), presets.get("filamentCount")))
            info["presets"] = True
        except (OSError, ValueError) as ex:
            info["presets"] = False
            info["presetError"] = str(ex)[:300]

    write_project_3mf(bodies, path, palette, body_colors, body_names, settings)
    return {"path": path, "info": info}


def register(registry, plugin_id):
    registry.register_exporter(EXPORTER, plugin_id, export_project)
