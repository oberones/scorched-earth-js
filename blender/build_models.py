"""
Blender build script for the Scorched Earth 3D assets.

Builds the tank, missile and nuke models from the shared spec (models/tank_spec.py),
assigns PBR materials, sets up the barrel as a child of the turret with its pivot at the
trunnion (so you can rotate it in Blender to test elevation), and exports .glb files.

Run (Blender 3.6 / 4.x):
    blender --background --python blender/build_models.py
or open it in Blender's Text Editor and press "Run Script".

Outputs:  models/blender/<name>.glb  and  models/blender/scorched_models.blend
After editing geometry in Blender, move your changes back into tank_spec.py (or export
your own glb) and re-run  python3 tools/export_models.py  to refresh the game data.
"""
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in dir() else os.getcwd()
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "models"))
from tank_spec import MATERIALS, all_models  # noqa: E402

OUT = os.path.join(ROOT, "models", "blender")
os.makedirs(OUT, exist_ok=True)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def get_material(name):
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    color, metallic, roughness = MATERIALS[name]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if name == "glow":
        key = "Emission Color" if "Emission Color" in bsdf.inputs else "Emission"
        bsdf.inputs[key].default_value = (*color, 1.0)
        if "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = 4.0
    return mat


def to_blender(v):
    # spec: Y up, Z toward camera  ->  Blender: Z up, -Y toward camera
    x, y, z = v
    return (x, -z, y)


def build(name, parts):
    coll = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(coll)
    root = bpy.data.objects.new(name.capitalize(), None)
    coll.objects.link(root)
    objs = {}
    for p in parts:
        mesh = bpy.data.meshes.new(p.name)
        mesh.from_pydata([to_blender(v) for v in p.verts], [], p.faces)
        mesh.update(calc_edges=True)
        mesh.materials.append(get_material(p.material))
        for poly in mesh.polygons:
            poly.use_smooth = False
        ob = bpy.data.objects.new(f"{name}_{p.name}", mesh)
        coll.objects.link(ob)
        ob.parent = root
        objs[p.name] = ob
    # jointed parts: verts are authored around the pivot -> place object at pivot
    for p in parts:
        if p.parent:
            ob = objs[p.name]
            ob.parent = objs[p.parent]
            ob.location = to_blender(p.pivot)
    return root, coll


def export_glb(coll, path):
    bpy.ops.object.select_all(action="DESELECT")
    for ob in coll.objects:
        ob.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_yup=True)


def main():
    reset_scene()
    offset = 0.0
    for name, parts in all_models().items():
        root, coll = build(name, parts)
        root.location.x = offset
        export_root_loc = root.location.copy()
        root.location = (0, 0, 0)
        export_glb(coll, os.path.join(OUT, f"{name}.glb"))
        root.location = export_root_loc
        offset += 4.0
        print(f"exported {name}.glb")
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "scorched_models.blend"))


if __name__ == "__main__":
    main()
