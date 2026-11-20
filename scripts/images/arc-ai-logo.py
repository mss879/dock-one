#!/usr/bin/env python3
"""
The "Designed by Arc AI" credit logo in the footer's status bar (src/components/layout/AccessGranted.tsx).

The agency's artwork (scripts/images/source/arc-ai-logo.webp: black "ARC", glossy orange "AI", already
on a transparent background) is mostly empty canvas, its letters sit at alpha 250-254 and a faint
halo of alpha 1-11 noise surrounds them. This trims it to the letters, makes them solid, drops the
halo and writes one lossless WebP that next/image resizes for the page.

Writes:
  public/brand/arc-ai-logo.webp

Run from the repo root:  python3 scripts/images/arc-ai-logo.py   (needs Pillow + numpy)
"""

from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "scripts/images/source/arc-ai-logo.webp"
OUT = ROOT / "public/brand/arc-ai-logo.webp"

WIDTH = 768  # the page shows it ~90px wide; next/image serves 1x/2x copies from this
HALO = 12  # alpha below this is background-removal noise
SOLID = 245  # alpha at or above this is the letter body
PAD = 6  # source pixels kept around the letters


def main() -> None:
    rgba = np.asarray(Image.open(SOURCE).convert("RGBA")).copy()
    alpha = rgba[..., 3]
    alpha[alpha < HALO] = 0
    alpha[alpha >= SOLID] = 255
    rgba[alpha == 0] = 0

    ys, xs = np.nonzero(alpha)
    top, bottom = max(ys.min() - PAD, 0), min(ys.max() + PAD + 1, rgba.shape[0])
    left, right = max(xs.min() - PAD, 0), min(xs.max() + PAD + 1, rgba.shape[1])
    logo = Image.fromarray(np.ascontiguousarray(rgba[top:bottom, left:right]))

    # Resize premultiplied, so transparent (black) pixels don't darken the anti-aliased edges.
    height = round(logo.height * WIDTH / logo.width)
    logo = logo.convert("RGBa").resize((WIDTH, height), Image.Resampling.LANCZOS).convert("RGBA")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    logo.save(OUT, "WEBP", lossless=True, quality=100, method=6)
    print(f"{OUT.relative_to(ROOT)}  {logo.width}x{logo.height}  {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
