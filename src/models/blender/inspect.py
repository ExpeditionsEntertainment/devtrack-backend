# Opens a .blend (or imports an .fbx) and writes what the model viewer needs:
#   blender -b -Y --factory-startup model.blend --python inspect.py -- out.glb out.json
#   blender -b -Y --factory-startup --python inspect.py -- out.glb out.json model.fbx
# out.glb   the model for the browser; each part carries its Blender object
#           name in its extras (three.js: userData.dt_part)
# out.json  { blender, parts: [{ name, hidden, verts, faces, materials, parent, collection, center, sides, from? }],
#             splits: { part: [its pieces] } }
# splits=list.json  parts to cut into their two sides first (common.split_parts); a side has "from": the part
# sides     whether a part has pieces on both sides of its middle (then the page offers to split it)
import bpy, json, os, sys
from mathutils import Vector
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import show_everything, parts, split_parts, two_sides

args = sys.argv[sys.argv.index('--') + 1:]
opts = dict(a.split('=', 1) for a in args if a.startswith('splits='))
args = [a for a in args if not a.startswith('splits=')]
glb, meta = args[:2]
# An FBX (an accessory added on the page): Blender started without a file, so empty it and import that.
if len(args) > 2:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=args[2])

hidden = {o.name for o in bpy.context.scene.objects if o.hide_get() or o.hide_viewport or not o.visible_get()}
show_everything()

made = {}
if opts.get('splits'):
    with open(opts['splits'], encoding='utf-8') as f:
        made = split_parts(json.load(f))
came_from = {p: whole for whole, pieces in made.items() if len(pieces) > 1 for p in pieces}

out = []
for o in parts():
    o['dt_part'] = o.name
    box = [o.matrix_world @ Vector(c) for c in o.bound_box]
    center = [sum(c[i] for c in box) / 8 for i in range(3)]
    out.append({
        'name': o.name,
        'hidden': o.name in hidden,
        'verts': len(o.data.vertices),
        'faces': len(o.data.polygons),
        'materials': [s.material.name for s in o.material_slots if s.material],
        'parent': o.parent.name if o.parent else None,
        'collection': o.users_collection[0].name if o.users_collection else None,
        'center': [round(c, 4) for c in center],
        'sides': two_sides(o),
        **({'from': came_from[o.name]} if o.name in came_from else {}),
    })

bpy.ops.export_scene.gltf(
    filepath=glb, export_format='GLB', use_selection=False, use_visible=False,
    export_extras=True, export_apply=True, export_animations=False,
    export_cameras=False, export_lights=False, export_yup=True,
)

with open(meta, 'w', encoding='utf-8') as f:
    # A rigged .blend (downloaded from the page, edited, uploaded back): what it was made from, and its bones.
    skinned = sorted(o.name for o in bpy.context.scene.objects
                     if o.type == 'MESH' and any(m.type == 'ARMATURE' and m.object for m in o.modifiers))
    arms = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
    json.dump({'blender': bpy.app.version_string, 'parts': out, 'splits': made, 'config': bpy.context.scene.get('dt_config'),
               'skinned': skinned, 'armatures': len(arms), 'bones': sum(len(a.data.bones) for a in arms)}, f)
