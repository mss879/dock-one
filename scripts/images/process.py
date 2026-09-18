#!/usr/bin/env python3
"""Turn raw generations into web assets + src/data/image-manifest.json.

Products (lap-/sto-/key-/mou-) get their background removed locally with rembg
(free, no credits) and are written twice: a square padded tile for product cards
and a tight-trimmed cutout for the pop-out category cards and banners.
Stages / heroes / promos are just resized to WebP.

Requires: pip3 install rembg pillow scipy
"""
import json, os, sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
RAW = os.path.join(HERE, "raw")
PUB = os.path.join(ROOT, "public", "images")
MANIFEST = os.path.join(ROOT, "src", "data", "image-manifest.json")
PRODUCT_PREFIXES = ("lap-", "sto-", "key-", "mou-")

_session = None


def session():
    global _session
    if _session is None:
        from rembg import new_session
        _session = new_session("isnet-general-use")
    return _session


def cut(src):
    from rembg import remove
    im = Image.open(src).convert("RGBA")
    out = remove(im, session=session(), alpha_matting=True,
                 alpha_matting_foreground_threshold=240,
                 alpha_matting_background_threshold=15,
                 alpha_matting_erode_size=6)
    out = repair_holes(out, im)
    alpha = out.getchannel("A").point(lambda v: 0 if v < 12 else v)
    out.putalpha(alpha)
    return out.crop(alpha.getbbox())


def repair_holes(cut_rgba, original):
    """Refill mask errors: enclosed transparent regions whose source pixels are
    product, not backdrop. Genuine see-through gaps (cable loops, key rings) show
    the backdrop colour and are left alone."""
    import numpy as np
    from scipy import ndimage

    rgb = np.asarray(original.convert("RGB"), dtype=np.int16)
    edge = np.concatenate([rgb[:8].reshape(-1, 3), rgb[-8:].reshape(-1, 3), rgb[:, :8].reshape(-1, 3), rgb[:, -8:].reshape(-1, 3)])
    backdrop = np.median(edge, axis=0)
    px = np.array(cut_rgba)
    labels, count = ndimage.label(px[..., 3] < 128)
    outside = set(np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])))
    for i in range(1, count + 1):
        if i in outside:
            continue
        region = labels == i
        if region.sum() < 64 or np.abs(rgb[region] - backdrop).sum(axis=1).mean() < 60:
            continue
        region = ndimage.binary_dilation(region, iterations=4)
        px[region, :3] = rgb[region].astype("uint8")
        px[region, 3] = 255
        print("   repaired mask hole:", int(region.sum()), "px")
    return Image.fromarray(px)


def save(im, rel, quality=88):
    path = os.path.join(PUB, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, "WEBP", quality=quality, method=6)
    return {"src": "/images/" + rel, "width": im.width, "height": im.height}


def fit(im, max_side):
    scale = max_side / max(im.size)
    if scale >= 1:
        return im
    return im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)


def newer(src, rel):
    dst = os.path.join(PUB, rel)
    return os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src)


manifest = {"products": {}, "stages": {}, "hero": {}, "promo": {}}
if os.path.exists(MANIFEST):
    manifest.update(json.load(open(MANIFEST)))

for name in sorted(os.listdir(RAW)):
    jid, ext = os.path.splitext(name)
    if ext.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
        continue
    src = os.path.join(RAW, name)
    if jid.startswith(PRODUCT_PREFIXES):
        if newer(src, f"products/{jid}.webp") and jid in manifest["products"] and "--force" not in sys.argv:
            continue
        trimmed = cut(src)
        w, h = trimmed.size
        side = round(max(w, h) * 1.12)
        tile = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        tile.paste(trimmed, ((side - w) // 2, (side - h) // 2), trimmed)
        manifest["products"][jid] = {
            "tile": save(tile.resize((1000, 1000), Image.LANCZOS), f"products/{jid}.webp"),
            "cutout": save(fit(trimmed, 1400), f"cutouts/{jid}.webp"),
        }
    else:
        group, key = jid.split("-", 1)
        folder = {"stage": "stages", "hero": "hero", "promo": "promo"}[group]
        rel = f"{folder}/{key}.webp"
        if newer(src, rel) and key in manifest[folder] and "--force" not in sys.argv:
            continue
        im = Image.open(src).convert("RGB")
        manifest[folder][key] = save(fit(im, {"stages": 1000, "hero": 2400, "promo": 1600}[folder]), rel, quality=84)
    print("processed", jid, flush=True)

os.makedirs(os.path.dirname(MANIFEST), exist_ok=True)
json.dump(manifest, open(MANIFEST, "w"), indent=2, sort_keys=True)
print("manifest ->", os.path.relpath(MANIFEST, ROOT))
