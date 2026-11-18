"""
Shared low-poly geometry spec for Scorched Earth 3D assets.

This module is plain Python (no Blender dependency) so the same geometry can be:
  * built inside Blender by  blender/build_models.py  (mesh.from_pydata + .glb export)
  * exported straight to glTF 2.0 by  tools/export_models.py  (no Blender needed)
  * baked into the game as  src/models.js

Units are metres. +X = right (barrel at 0 deg), +Y = up, +Z = towards the camera.
Every part is a convex solid; face winding is normalised so normals point outward.
"""
import math

MATERIALS = {
    # name: (base colour RGB 0-1, metallic, roughness)
    "body":     ((0.55, 0.60, 0.35), 0.2, 0.6),   # replaced by team colour in game
    "bodyDark": ((0.38, 0.42, 0.24), 0.2, 0.7),   # team colour, darkened
    "track":    ((0.13, 0.13, 0.15), 0.1, 0.9),
    "metal":    ((0.48, 0.51, 0.55), 0.8, 0.35),
    "gunmetal": ((0.22, 0.23, 0.26), 0.9, 0.3),
    "accent":   ((0.85, 0.66, 0.18), 0.6, 0.4),
    "warhead":  ((0.80, 0.20, 0.16), 0.3, 0.5),
    "glow":     ((1.00, 0.75, 0.30), 0.0, 1.0),
}


# --------------------------------------------------------------------------- #
# Primitive builders. Each returns (verts, faces) with faces as index polygons.
# --------------------------------------------------------------------------- #
def prism(profile, z0, z1):
    """Extrude a convex XY polygon along Z from z0 to z1."""
    n = len(profile)
    verts = [(x, y, z0) for x, y in profile] + [(x, y, z1) for x, y in profile]
    faces = [list(range(n)), list(range(n, 2 * n))]
    for i in range(n):
        j = (i + 1) % n
        faces.append([i, j, n + j, n + i])
    return verts, faces


def lathe(profile, segments, axis="y", offset=(0.0, 0.0, 0.0)):
    """Revolve a list of (radius, height) points around an axis; caps both ends."""
    verts, faces = [], []
    rings = len(profile)
    for r, h in profile:
        for s in range(segments):
            a = 2 * math.pi * s / segments + math.pi / segments
            c, d = r * math.cos(a), r * math.sin(a)
            if axis == "y":
                p = (c, h, d)
            elif axis == "x":
                p = (h, c, d)
            else:  # z
                p = (c, d, h)
            verts.append((p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]))
    for k in range(rings - 1):
        for s in range(segments):
            t = (s + 1) % segments
            a, b = k * segments + s, k * segments + t
            faces.append([a, b, b + segments, a + segments])
    faces.append(list(range(segments)))
    faces.append(list(range((rings - 1) * segments, rings * segments)))
    return verts, faces


def box(x0, x1, y0, y1, z0, z1):
    return prism([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], z0, z1)


def stadium(cx0, cx1, cy, r, segs=6):
    """Rounded-end track profile (convex) in XY."""
    pts = []
    for i in range(segs + 1):  # right cap, bottom -> top
        a = -math.pi / 2 + math.pi * i / segs
        pts.append((cx1 + r * math.cos(a), cy + r * math.sin(a)))
    for i in range(segs + 1):  # left cap, top -> bottom
        a = math.pi / 2 + math.pi * i / segs
        pts.append((cx0 + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def circle(cx, cy, r, segs):
    return [(cx + r * math.cos(2 * math.pi * i / segs), cy + r * math.sin(2 * math.pi * i / segs))
            for i in range(segs)]


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def orient_outward(verts, faces):
    """Flip any face whose Newell normal points toward the solid's centroid."""
    n = len(verts)
    c = tuple(sum(v[i] for v in verts) / n for i in range(3))
    out = []
    for f in faces:
        nx = ny = nz = 0.0
        for i in range(len(f)):
            p, q = verts[f[i]], verts[f[(i + 1) % len(f)]]
            nx += (p[1] - q[1]) * (p[2] + q[2])
            ny += (p[2] - q[2]) * (p[0] + q[0])
            nz += (p[0] - q[0]) * (p[1] + q[1])
        fc = tuple(sum(verts[i][k] for i in f) / len(f) for k in range(3))
        out.append(f if _dot((nx, ny, nz), _sub(fc, c)) >= 0 else list(reversed(f)))
    return out


class Part:
    def __init__(self, name, material, verts, faces, pivot=(0.0, 0.0, 0.0), parent=None):
        self.name, self.material, self.pivot, self.parent = name, material, pivot, parent
        self.verts = [tuple(round(c, 5) for c in v) for v in verts]
        self.faces = orient_outward(self.verts, faces)


def merge_convex(name, material, pieces, **kw):
    """Merge several convex solids into one part, orienting each piece on its own."""
    verts, faces = [], []
    for v, f in pieces:
        f = orient_outward(v, f)
        base = len(verts)
        verts += v
        faces += [[i + base for i in poly] for poly in f]
    p = Part.__new__(Part)
    p.name, p.material, p.pivot, p.parent = name, material, kw.get("pivot", (0, 0, 0)), kw.get("parent")
    p.verts = [tuple(round(c, 5) for c in v) for v in verts]
    p.faces = faces
    return p


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #
TURRET_PIVOT = (0.0, 0.84, 0.0)


def build_tank():
    parts = []
    hull = [(-1.10, 0.26), (1.10, 0.26), (1.28, 0.46), (0.92, 0.64), (-0.98, 0.64), (-1.24, 0.46)]
    parts.append(Part("Hull", "body", *prism(hull, -0.44, 0.44)))

    skirt = []
    for z0, z1 in ((0.42, 0.74), (-0.74, -0.42)):
        skirt.append(prism([(-1.26, 0.44), (1.26, 0.44), (1.30, 0.50), (-1.30, 0.50)], z0, z1))
    parts.append(merge_convex("Skirts", "bodyDark", skirt))

    tracks = [prism(stadium(-1.02, 1.02, 0.22, 0.22, 6), z0, z1) for z0, z1 in ((0.44, 0.70), (-0.70, -0.44))]
    parts.append(merge_convex("Tracks", "track", tracks))

    wheels = []
    for zc in (0.71, -0.71):
        for i in range(5):
            x = -0.84 + i * 0.42
            wheels.append(prism(circle(x, 0.20, 0.15, 10), zc - 0.03, zc + 0.03))
        for x in (-1.02, 1.02):
            wheels.append(prism(circle(x, 0.22, 0.10, 8), zc - 0.035, zc + 0.035))
    parts.append(merge_convex("Wheels", "metal", wheels))

    parts.append(Part("Turret", "body", *lathe([(0.58, 0.62), (0.54, 0.84), (0.38, 1.00)], 8)))
    parts.append(Part("TurretRing", "bodyDark", *lathe([(0.62, 0.60), (0.62, 0.66)], 8)))
    parts.append(Part("Hatch", "accent", *lathe([(0.15, 0.99), (0.13, 1.06)], 8, offset=(-0.12, 0, 0.05))))

    barrel = [
        lathe([(0.15, 0.18), (0.15, 0.40)], 8, axis="x"),  # mantlet
        lathe([(0.075, 0.38), (0.065, 1.30)], 8, axis="x"),  # tube
        lathe([(0.105, 1.24), (0.105, 1.44)], 8, axis="x"),  # muzzle brake
    ]
    parts.append(merge_convex("Barrel", "gunmetal", barrel, pivot=TURRET_PIVOT, parent="Turret"))
    return parts


def build_missile():
    body = Part("Body", "metal", *lathe([(0.11, -0.45), (0.11, 0.25)], 8, axis="x"))
    nose = Part("Nose", "warhead", *lathe([(0.11, 0.25), (0.06, 0.42), (0.015, 0.52)], 8, axis="x"))
    fins = []
    for sy, sz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        if sy:
            fins.append(box(-0.45, -0.22, 0.0, 0.24 * sy, -0.012, 0.012) if sy > 0
                        else box(-0.45, -0.22, -0.24, 0.0, -0.012, 0.012))
        else:
            fins.append(box(-0.45, -0.22, -0.012, 0.012, 0.0, 0.24) if sz > 0
                        else box(-0.45, -0.22, -0.012, 0.012, -0.24, 0.0))
    fin = merge_convex("Fins", "accent", fins)
    flame = Part("Exhaust", "glow", *lathe([(0.07, -0.47), (0.03, -0.62)], 6, axis="x"))
    return [body, nose, fin, flame]


def build_nuke():
    """Fat bomb-shaped shell for nuclear weapons."""
    body = Part("Body", "gunmetal", *lathe([(0.12, -0.42), (0.22, -0.20), (0.24, 0.10), (0.18, 0.32), (0.06, 0.44)], 10, axis="x"))
    band = Part("Band", "accent", *lathe([(0.25, -0.05), (0.25, 0.05)], 10, axis="x"))
    fins = merge_convex("Fins", "warhead", [
        box(-0.55, -0.32, 0.0, 0.26, -0.015, 0.015), box(-0.55, -0.32, -0.26, 0.0, -0.015, 0.015),
        box(-0.55, -0.32, -0.015, 0.015, 0.0, 0.26), box(-0.55, -0.32, -0.015, 0.015, -0.26, 0.0),
    ])
    return [body, band, fins]


MODELS = {"tank": build_tank, "missile": build_missile, "nuke": build_nuke}


def all_models():
    return {name: fn() for name, fn in MODELS.items()}


if __name__ == "__main__":
    for name, parts in all_models().items():
        print(name, sum(len(p.faces) for p in parts), "faces", [p.name for p in parts])
