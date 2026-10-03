#!/usr/bin/env python3
"""
Raster derivatives of the client's logo (vector pieces: src/components/brand/logo-paths.ts, made by
scripts/images/logo.py): the gold DO monogram on an ink tile with the brand chamfer (top-right +
bottom-left, DESIGN.md §5), plus the square logo for search engines. (Emails use icon-192.png.)

Google wants a favicon that is a multiple of 48px (48 in the .ico, 96 and 192 PNGs, the SVG);
browsers take the SVG or the .ico; iOS takes the 180px apple-icon; Android/Chrome install takes the
manifest icons (plain + maskable, mark inside the 80% safe zone).

Writes:
  src/app/favicon.ico        16, 32, 48
  src/app/icon.svg           any size
  src/app/icon1.png          96
  src/app/icon2.png          192
  src/app/apple-icon.png     180  (full bleed, iOS rounds the corners itself)
  public/icons/icon-192.png, icon-512.png           manifest "any"
  public/icons/maskable-192.png, maskable-512.png   manifest "maskable"
  public/brand/dock-one-logo-512.png   the monogram on an ink square (Organization JSON-LD)

Run from the repo root:  python3 scripts/images/icons.py   (needs Pillow + numpy)
"""

import io
import re
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
PATHS_TS = ROOT / "src/components/brand/logo-paths.ts"

INK = "#0b0b0c"
SUPERSAMPLE = 8

# Favicon tile on a 16-unit grid: chamfer 2, monogram 14 wide, centred.
UNIT, CHAMFER, MARK_W = 16, 2, 14


def rgba(hex_colour: str, alpha: int = 255) -> tuple[int, int, int, int]:
    h = hex_colour.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), alpha


# ── the monogram ────────────────────────────────────────────────────────────────

def load_pieces() -> dict:
    ts = PATHS_TS.read_text()
    m = re.search(r'export const MARK = { w: (\d+), h: (\d+), d: "([^"]+)" }', ts)
    return {
        "gold": re.search(r'LOGO_GOLD = "(#[0-9a-f]{6})"', ts).group(1),
        "MARK": {"w": int(m.group(1)), "h": int(m.group(2)), "d": m.group(3)},
    }


def subpaths(d: str) -> list[list[tuple[float, float]]]:
    """Flatten an M/L/C/Z path (the only commands logo.py writes) into closed polygons."""
    tokens = re.findall(r"[MLCZ]|-?\d*\.?\d+", d)
    polys, poly, i, cur = [], [], 0, (0.0, 0.0)
    while i < len(tokens):
        cmd = tokens[i]
        i += 1
        if cmd == "M":
            cur = (float(tokens[i]), float(tokens[i + 1]))
            i += 2
            poly = [cur]
        elif cmd == "L":
            cur = (float(tokens[i]), float(tokens[i + 1]))
            i += 2
            poly.append(cur)
        elif cmd == "C":
            p0 = cur
            p1, p2, p3 = [(float(tokens[i + k]), float(tokens[i + k + 1])) for k in (0, 2, 4)]
            i += 6
            for step in range(1, 25):
                t = step / 24
                mt = 1 - t
                poly.append((
                    mt**3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t**3 * p3[0],
                    mt**3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t**3 * p3[1],
                ))
            cur = p3
        elif cmd == "Z":
            polys.append(poly)
    return polys


def paint(canvas: Image.Image, d: str, x: float, y: float, scale: float, colour: str) -> None:
    """Fill path `d` (artwork px) at (x, y) canvas px, even-odd (potrace contours never overlap)."""
    mask = np.zeros((canvas.height, canvas.width), dtype=bool)
    for poly in subpaths(d):
        layer = Image.new("1", canvas.size, 0)
        ImageDraw.Draw(layer).polygon([(x + px * scale, y + py * scale) for px, py in poly], fill=1)
        mask ^= np.asarray(layer, dtype=bool)
    canvas.paste(Image.new("RGBA", canvas.size, rgba(colour)), (0, 0), Image.fromarray(mask.astype(np.uint8) * 255))


# ── icons ──────────────────────────────────────────────────────────────────────

def icon(px: int, logo: dict, *, chamfer: float, mark_w: float, unit: float) -> Image.Image:
    """Ink tile (chamfered or full bleed) with the gold monogram centred, `mark_w` of `unit` wide."""
    size = px * SUPERSAMPLE
    k = size / unit
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    c = chamfer * k
    tile = [(0, 0), (size - c, 0), (size, c), (size, size), (c, size), (0, size - c)] if c else [(0, 0), (size, 0), (size, size), (0, size)]
    ImageDraw.Draw(im).polygon(tile, fill=rgba(INK))
    mark = logo["MARK"]
    scale = mark_w * k / mark["w"]
    paint(im, mark["d"], (size - mark["w"] * scale) / 2, (size - mark["h"] * scale) / 2, scale, logo["gold"])
    return im.resize((px, px), Image.Resampling.BOX)


def tile(px: int, logo: dict) -> Image.Image:
    return icon(px, logo, chamfer=CHAMFER, mark_w=MARK_W, unit=UNIT)


def full_bleed(px: int, logo: dict, mark_w: int) -> Image.Image:
    return icon(px, logo, chamfer=0, mark_w=mark_w, unit=px)


def png_bytes(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def save_png(im: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png_bytes(im))
    print(f"{path.relative_to(ROOT)}  {im.width}x{im.height}  {path.stat().st_size} B")


def save_ico(images: list[Image.Image], path: Path) -> None:
    """ICO with one PNG-encoded entry per size (each drawn at its own size, not resampled)."""
    blobs = [png_bytes(im) for im in images]
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b""
    for im, blob in zip(images, blobs):
        entries += struct.pack("<BBBBHHII", im.width % 256, im.height % 256, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
    path.write_bytes(header + entries + b"".join(blobs))
    print(f"{path.relative_to(ROOT)}  {'/'.join(str(im.width) for im in images)}  {path.stat().st_size} B")


def svg_icon(logo: dict) -> str:
    mark = logo["MARK"]
    scale = MARK_W / mark["w"]
    tx, ty = (UNIT - MARK_W) / 2, (UNIT - mark["h"] * scale) / 2
    s, c = UNIT, CHAMFER
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {s} {s}">'
        f'<path fill="{INK}" d="M0 0h{s - c}l{c} {c}v{s - c}H{c}l-{c}-{c}z"/>'
        f'<path fill="{logo["gold"]}" transform="translate({tx:.4g} {ty:.4g}) scale({scale:.6g})" d="{mark["d"]}"/>'
        "</svg>\n"
    )


# ── brand rasters ──────────────────────────────────────────────────────────────

def square_logo(logo: dict, px: int = 512) -> Image.Image:
    """The monogram on an ink square — the icon without the chamfer (search engines crop their own shape)."""
    return full_bleed(px, logo, mark_w=round(px * 0.7))


def main() -> None:
    logo = load_pieces()
    app, icons, brand = ROOT / "src/app", ROOT / "public/icons", ROOT / "public/brand"
    save_ico([tile(s, logo) for s in (16, 32, 48)], app / "favicon.ico")
    (app / "icon.svg").write_text(svg_icon(logo))
    print(f"src/app/icon.svg  {(app / 'icon.svg').stat().st_size} B")
    save_png(tile(96, logo), app / "icon1.png")
    save_png(tile(192, logo), app / "icon2.png")
    save_png(full_bleed(180, logo, mark_w=132), app / "apple-icon.png")
    save_png(tile(192, logo), icons / "icon-192.png")
    save_png(tile(512, logo), icons / "icon-512.png")
    # maskable: the monogram's half-diagonal stays inside the 40% safe radius
    save_png(full_bleed(192, logo, mark_w=120), icons / "maskable-192.png")
    save_png(full_bleed(512, logo, mark_w=320), icons / "maskable-512.png")
    save_png(square_logo(logo), brand / "dock-one-logo-512.png")


if __name__ == "__main__":
    main()
