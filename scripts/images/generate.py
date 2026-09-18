#!/usr/bin/env python3
"""Generate the store imagery with the Higgsfield CLI.

Each job in jobs.json runs at most once: ids that already have raw/<id>.png are
skipped, so re-running only spends credits on what is still missing.

  python3 scripts/images/generate.py                  # everything still missing
  python3 scripts/images/generate.py --only key-01,key-02
  python3 scripts/images/generate.py --redo sto-01    # regenerate sto-01 + anything still missing
  python3 scripts/images/generate.py --model seedream_v4_5 --only hero-opening

Default model is z_image (0.15 credits / 2048px image).
"""
import argparse, json, os, subprocess, urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")

ap = argparse.ArgumentParser()
ap.add_argument("--model", default="z_image")
ap.add_argument("--only", default="")
ap.add_argument("--redo", default="")
ap.add_argument("--workers", type=int, default=3)
args = ap.parse_args()

cfg = json.load(open(os.path.join(HERE, "jobs.json")))
suffix = {"white": cfg["_product_white"], "gray": cfg["_product_gray"], "none": ""}
only = {s for s in args.only.split(",") if s}
redo = {s for s in args.redo.split(",") if s}
os.makedirs(RAW, exist_ok=True)
for jid in redo:
    path = os.path.join(RAW, f"{jid}.png")
    if os.path.exists(path):
        os.remove(path)


def run(job):
    jid = job["id"]
    out = os.path.join(RAW, f"{jid}.png")
    if os.path.exists(out):
        return f"skip  {jid}"
    prompt = job["prompt"] + (", " + suffix[job["bg"]] if suffix[job["bg"]] else "")
    cmd = ["higgsfield", "generate", "create", args.model, "--json", "--wait",
           "--aspect_ratio", job["ar"], "--prompt", prompt]
    p = subprocess.run(cmd, capture_output=True, text=True)
    try:
        data = json.loads(p.stdout)[0]
        if data["status"] != "completed":
            return f"FAIL  {jid}: status={data['status']}"
        urllib.request.urlretrieve(data["result_url"], out)
        return f"ok    {jid}"
    except Exception:
        return f"FAIL  {jid}: {(p.stderr or p.stdout).strip()[:220]}"


jobs = [j for j in cfg["jobs"] if not only or j["id"] in only]
with ThreadPoolExecutor(max_workers=args.workers) as ex:
    for line in ex.map(run, jobs):
        print(line, flush=True)
print("\nNext: python3 scripts/images/process.py")
