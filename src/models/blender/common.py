# Shared by inspect.py and export.py. Blender adds this folder to sys.path
# because the script that imports it lives here.
import bpy
from mathutils import Vector


def show_everything():
    """Make every object in the scene count: hidden objects and switched-off
    collections are part of the model too. Only this run's copy changes; the
    .blend file is never saved."""
    def walk(layer_collection):
        layer_collection.exclude = False
        layer_collection.hide_viewport = False
        layer_collection.collection.hide_viewport = False
        layer_collection.collection.hide_render = False
        for child in layer_collection.children:
            walk(child)
    walk(bpy.context.view_layer.layer_collection)
    for o in bpy.context.scene.objects:
        o.hide_viewport = False
        o.hide_render = False
        try:
            o.hide_set(False)
        except RuntimeError:
            pass


def parts():
    """The parts of the model: every mesh object, in Outliner (A to Z) order."""
    return sorted((o for o in bpy.context.scene.objects if o.type == 'MESH'), key=lambda o: o.name.lower())


def two_sides(o):
    """Whether a part, as it shows (its modifiers applied, so a mirror's other half counts), has loose pieces
    on both sides of its own middle, like both arms in one mesh: then it can be split into its two sides."""
    ev = o.evaluated_get(bpy.context.evaluated_depsgraph_get())
    m = ev.to_mesh()
    try:
        xs = [(o.matrix_world @ v.co).x for v in m.vertices]
        if len(xs) < 2:
            return False
        up = list(range(len(xs)))

        def root(a):
            while up[a] != a:
                up[a] = up[up[a]]
                a = up[a]
            return a
        for e in m.edges:
            a, b = root(e.vertices[0]), root(e.vertices[1])
            if a != b:
                up[a] = b
        spans = {}
        for i, x in enumerate(xs):
            r = root(i)
            lo, hi = spans.get(r, (x, x))
            spans[r] = (min(lo, x), max(hi, x))
        lo, hi = min(xs), max(xs)
        if len(spans) < 2 or hi <= lo:
            return False
        mid, eps = (lo + hi) / 2, (hi - lo) * 0.02
        middles = [(a + b) / 2 for a, b in spans.values()]
        return any(c < mid - eps for c in middles) and any(c > mid + eps for c in middles)
    finally:
        ev.to_mesh_clear()


def _center(o):
    box = [o.matrix_world @ Vector(c) for c in o.bound_box]
    return Vector([sum(c[i] for c in box) / 8 for i in range(3)])


def _join(objs, keep=None):
    """objs made one object (the one kept, or the first); returns it."""
    for other in bpy.context.view_layer.objects:
        other.select_set(False)
    for ob in objs:
        ob.select_set(True)
    active = keep if keep in objs else objs[0]
    bpy.context.view_layer.objects.active = active
    if len(objs) > 1:
        bpy.ops.object.join()
    return active


def split_parts(names):
    """Each named part cut into its two sides (both arms left in one mesh, a mirror never applied): its
    loose pieces grouped by which side of the part's own middle they're on, each side one part with its
    origin in its own middle, named "<part> 1" (the -X side) and "<part> 2", the same on every run.
    The part's modifiers are applied first (all but Armature), so a mirror's other half counts.
    Returns { part: [its sides' names] }; a part with nothing on one side keeps its name."""
    made = {}
    for name in names:
        o = bpy.data.objects.get(name)
        if o is None or o.type != 'MESH' or name not in bpy.context.view_layer.objects:
            continue
        if bpy.context.object and bpy.context.object.mode != 'OBJECT':
            bpy.ops.object.mode_set(mode='OBJECT')
        for other in bpy.context.view_layer.objects:
            other.select_set(False)
        o.hide_select = False
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        if o.data.users > 1:  # shared with another object: cut a copy of its own
            o.data = o.data.copy()
        for mod in list(o.modifiers):
            if mod.type == 'ARMATURE':
                continue
            try:
                bpy.ops.object.modifier_apply(modifier=mod.name)
            except RuntimeError as e:
                print(f'Could not apply {mod.name} on {name}: {e}')
        box = [o.matrix_world @ Vector(c) for c in o.bound_box]
        mid = (min(c.x for c in box) + max(c.x for c in box)) / 2
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.mesh.separate(type='LOOSE')
        bpy.ops.object.mode_set(mode='OBJECT')
        pieces = [p for p in bpy.context.selected_objects if p.type == 'MESH']
        bpy.context.view_layer.update()
        low = [p for p in pieces if _center(p).x < mid]
        high = [p for p in pieces if p not in low]
        if not low or not high:  # all on one side: put it back together
            _join(pieces, keep=o)
            made[name] = [name]
            continue
        sides = [_join(low, keep=o), _join(high, keep=o)]
        for other in bpy.context.view_layer.objects:
            other.select_set(False)
        for s in sides:
            s.select_set(True)
        bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='BOUNDS')
        for i, s in enumerate(sides):
            s.name = f'__dt_side_{i}'
        for i, s in enumerate(sides, 1):
            s.name = f'{name} {i}'
            if s.data.users == 1:
                s.data.name = s.name
        made[name] = [s.name for s in sides]
    for other in bpy.context.view_layer.objects:
        other.select_set(False)
    return made
