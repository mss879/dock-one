#!/usr/bin/env python3
"""
Favicon + app icons from the logo mark (src/components/layout/Logo.tsx, dark tone): the 3×3 grid
on an ink tile with the brand chamfer (top-right + bottom-left, DESIGN.md §5).

The tile is drawn on a 16-unit grid (1 padding, 4 cell, 1 gap), so every size that is a multiple
of 16 lands on whole pixels and stays sharp. Google wants a favicon that is a multiple of 48px
(48 in the .ico, 96 and 192 PNGs, the SVG); browsers take the SVG or the .ico; iOS takes the
180px apple-icon; Android/Chrome install takes the manifest icons (plain + maskable).

Writes:
  src/app/favicon.ico        16, 32, 48
  src/app/icon.svg           any size
  src/app/icon1.png          96
  src/app/icon2.png          192
  src/app/apple-icon.png     180  (full bleed, iOS rounds the corners itself)
  public/icons/icon-192.png, icon-512.png           manifest "any"
  public/icons/maskable-192.png, maskable-512.png   manifest "maskable" (mark inside the 80% safe zone)

Run from the repo root:  python3 scripts/images/icons.py   (needs Pillow)
"""

import io
import struct
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]

INK = "#0b0b0c"
PAPER = "#f3f3f1"
VIOLET = "#6d3bff"
LIME = "#d4ff3a"

# (row, col, colour) — Logo.tsx with tone="dark" (ink cells become paper)
CELLS = [(0, 0, PAPER), (0, 2, VIOLET), (1, 1, PAPER), (2, 0, LIME), (2, 2, PAPER)]

UNIT, PAD, CELL, GAP, CHAMFER = 16, 1, 4, 1, 2
SUPERSAMPLE = 16


def rgba(hex_colour: str) -> tuple[int, int, int, int]:
    h = hex_colour.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255


def draw(px: int, *, unit: float, pad: float, cell: float, gap: float, chamfer: float) -> Image.Image:
    """Render at SUPERSAMPLE× and box-filter down: whole-pixel edges stay crisp, the chamfer is anti-aliased."""
    size = px * SUPERSAMPLE
    k = size / unit
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c = chamfer * k
    tile = [(0, 0), (size - c, 0), (size, c), (size, size), (c, size), (0, size - c)] if c else [(0, 0), (size, 0), (size, size), (0, size)]
    d.polygon(tile, fill=rgba(INK))
    for row, col, colour in CELLS:
        x = (pad + col * (cell + gap)) * k
        y = (pad + row * (cell + gap)) * k
        d.rectangle([round(x), round(y), round(x + cell * k) - 1, round(y + cell * k) - 1], fill=rgba(colour))
    return im.resize((px, px), Image.Resampling.BOX)


def tile(px: int) -> Image.Image:
    return draw(px, unit=UNIT, pad=PAD, cell=CELL, gap=GAP, chamfer=CHAMFER)


def full_bleed(px: int, cell: float, gap: float) -> Image.Image:
    """Square ink tile, mark centred — for platforms that apply their own mask."""
    mark = 3 * cell + 2 * gap
    return draw(px, unit=px, pad=(px - mark) / 2, cell=cell, gap=gap, chamfer=0)


def png_bytes(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def save_png(im: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png_bytes(im))
    print(f"{path.relative_to(ROOT)}  {im.width}x{im.height}  {path.stat().st_size} B")


def save_ico(sizes: list[int], path: Path) -> None:
    """ICO with one PNG-encoded entry per size (each drawn at its own size, not resampled)."""
    blobs = [png_bytes(tile(s)) for s in sizes]
    header = struct.pack("<HHH", 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    entries = b""
    for s, blob in zip(sizes, blobs):
        entries += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
    path.write_bytes(header + entries + b"".join(blobs))
    print(f"{path.relative_to(ROOT)}  {'/'.join(map(str, sizes))}  {path.stat().st_size} B")


def svg() -> str:
    def rect(row: int, col: int) -> str:
        x, y = PAD + col * (CELL + GAP), PAD + row * (CELL + GAP)
        return f"M{x} {y}h{CELL}v{CELL}h-{CELL}z"

    by_colour: dict[str, list[str]] = {}
    for row, col, colour in CELLS:
        by_colour.setdefault(colour, []).append(rect(row, col))
    s, c = UNIT, CHAMFER
    paths = [f'<path fill="{INK}" d="M0 0h{s - c}l{c} {c}v{s - c}H{c}l-{c}-{c}z"/>']
    paths += [f'<path fill="{colour}" d="{"".join(d)}"/>' for colour, d in by_colour.items()]
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {s} {s}">{"".join(paths)}</svg>\n'


def main() -> None:
    app, icons = ROOT / "src/app", ROOT / "public/icons"
    save_ico([16, 32, 48], app / "favicon.ico")
    (app / "icon.svg").write_text(svg())
    print(f"src/app/icon.svg  {(app / 'icon.svg').stat().st_size} B")
    save_png(tile(96), app / "icon1.png")
    save_png(tile(192), app / "icon2.png")
    save_png(full_bleed(180, cell=36, gap=9), app / "apple-icon.png")
    save_png(tile(192), icons / "icon-192.png")
    save_png(tile(512), icons / "icon-512.png")
    save_png(full_bleed(192, cell=30, gap=8), icons / "maskable-192.png")
    save_png(full_bleed(512, cell=80, gap=20), icons / "maskable-512.png")


if __name__ == "__main__":
    main()
