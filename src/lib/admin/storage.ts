"use client";

import { supabaseStoragePublicPrefix } from "@/lib/env";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import { describeAdminError, NOT_CONFIGURED_MESSAGE } from "./errors";

/**
 * Admin image uploads (blueprint §11.2 Products, BUILD_SPEC §2.2). The browser converts every
 * image to WebP on a canvas (≤ 2000 px on the long side, quality ≈ 0.85) before it goes to
 * Supabase Storage, then the PUBLIC URL is stored on the row (`image_url = image_urls[1]`).
 *
 *   const res = await uploadImage(file, { bucket: "product-images", prefix: `products/${product.id}` });
 *   if (res.ok) setImages((urls) => [...urls, res.url]);
 *
 * Buckets (04_catalogue.sql): public, raster only, 5 MB cap, admin-only writes.
 * File names are unique (never overwritten), so the CDN can't serve a stale image after a
 * replace. Browsers that can't ENCODE WebP (older Safari) get JPEG — or PNG when the source
 * may be transparent, so a product cut-out keeps its alpha.
 *
 * Removing an image from a form does NOT delete the file: save the row first, then (optionally)
 * `removeImage(url)` for the URLs that are no longer referenced (see `unreferencedImages`).
 */

export type ImageBucket = "product-images" | "content-images";
export const IMAGE_BUCKETS: readonly ImageBucket[] = ["product-images", "content-images"];

export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // = bucket file_size_limit
export const DEFAULT_MAX_DIMENSION = 2000;
export const DEFAULT_QUALITY = 0.85;
export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"] as const;
export const IMAGE_ACCEPT = ACCEPTED_IMAGE_TYPES.join(",");

export type UploadOptions = {
  bucket: ImageBucket;
  /** Folder inside the bucket, e.g. "products/42", "hero", "blog/7". Letters, digits, - _ / only. */
  prefix: string;
  maxDimension?: number;
  quality?: number;
};

export type UploadedImage = {
  ok: true;
  url: string;
  path: string;
  bucket: ImageBucket;
  width: number;
  height: number;
  bytes: number;
  contentType: string;
};
export type UploadFailure = { ok: false; message: string };

type Encoded = { blob: Blob; width: number; height: number; extension: "webp" | "jpg" | "png" };

function cleanPrefix(prefix: string): string | null {
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed || trimmed.length > 120) return null;
  if (!/^[a-z0-9][a-z0-9/_-]*$/i.test(trimmed) || trimmed.split("/").some((segment) => !segment || segment === "." || segment === "..")) return null;
  return trimmed;
}

function uniqueName(extension: string): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `${Date.now().toString(36)}-${random}.${extension}`;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      resolve(null);
    }
  });
}

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // fall through to <img> decoding (some browsers can't bitmap-decode every format)
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** Convert an image file to WebP (or the fallback), scaled so the long side ≤ maxDimension. */
export async function convertImage(file: Blob, options: { maxDimension?: number; quality?: number } = {}): Promise<Encoded> {
  const maxDimension = Math.max(64, Math.min(options.maxDimension ?? DEFAULT_MAX_DIMENSION, 4096));
  const quality = Math.min(1, Math.max(0.4, options.quality ?? DEFAULT_QUALITY));
  const decoded = await decode(file);
  try {
    if (!decoded.width || !decoded.height) throw new Error("empty image");
    const scale = Math.min(1, maxDimension / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(decoded.source, 0, 0, width, height);

    // WebP first; step the quality down if a huge image would exceed the bucket's 5 MB cap.
    for (const q of [quality, 0.75, 0.6]) {
      const webp = await canvasToBlob(canvas, "image/webp", q);
      if (webp && webp.type === "image/webp") {
        if (webp.size <= MAX_UPLOAD_BYTES || q === 0.6) return { blob: webp, width, height, extension: "webp" };
        continue;
      }
      break; // this browser can't encode WebP
    }
    const mayBeTransparent = file.type === "image/png" || file.type === "image/webp" || file.type === "image/avif" || file.type === "image/gif";
    if (mayBeTransparent) {
      const png = await canvasToBlob(canvas, "image/png", 1);
      if (png && png.size <= MAX_UPLOAD_BYTES) return { blob: png, width, height, extension: "png" };
    }
    const jpeg = await canvasToBlob(canvas, "image/jpeg", Math.min(quality, 0.85));
    if (!jpeg) throw new Error("encode failed");
    return { blob: jpeg, width, height, extension: "jpg" };
  } finally {
    decoded.release();
  }
}

/** Convert + upload one image. Never throws. */
export async function uploadImage(file: File | Blob, options: UploadOptions): Promise<UploadedImage | UploadFailure> {
  if (!IMAGE_BUCKETS.includes(options.bucket)) return { ok: false, message: "Unknown image bucket." };
  const prefix = cleanPrefix(options.prefix);
  if (!prefix) return { ok: false, message: "Invalid upload folder." };
  if (file.type && !(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, message: "Use a JPG, PNG, WebP, AVIF or GIF image (SVG and other formats aren't accepted)." };
  }
  if (file.size > MAX_SOURCE_BYTES) return { ok: false, message: "That image is larger than 25 MB. Export a smaller version and try again." };

  const supabase = getBrowserSupabase();
  if (!supabase) return { ok: false, message: NOT_CONFIGURED_MESSAGE };

  let encoded: Encoded;
  try {
    encoded = await convertImage(file, options);
  } catch (error) {
    console.error("[admin] image conversion failed", error);
    return { ok: false, message: "This image couldn't be read by your browser. Save it as JPG or PNG and try again." };
  }
  if (encoded.blob.size > MAX_UPLOAD_BYTES) {
    return { ok: false, message: "Even after compression this image is over 5 MB. Use a smaller image." };
  }

  const contentType = encoded.blob.type || `image/${encoded.extension === "jpg" ? "jpeg" : encoded.extension}`;
  const path = `${prefix}/${uniqueName(encoded.extension)}`;
  try {
    const { data, error } = await supabase.storage.from(options.bucket).upload(path, encoded.blob, {
      contentType,
      cacheControl: "31536000",
      upsert: false,
    });
    if (error || !data?.path) {
      const described = describeAdminError(error, { migration: "04_catalogue.sql" });
      console.error("[admin] upload failed", error);
      const status = (error as { statusCode?: string | number } | null)?.statusCode;
      const message =
        String(status) === "403" || /row-level security|Unauthorized/i.test(error?.message ?? "")
          ? "Storage refused the upload. Check that you're signed in as an admin and that 04_catalogue.sql created the image buckets."
          : String(status) === "404" || /Bucket not found/i.test(error?.message ?? "")
            ? `The “${options.bucket}” bucket doesn't exist yet — apply 04_catalogue.sql.`
            : String(status) === "413" || /exceeded the maximum allowed size/i.test(error?.message ?? "")
              ? "The image is over the bucket's 5 MB limit."
              : described.message;
      return { ok: false, message };
    }
    const { data: publicUrl } = supabase.storage.from(options.bucket).getPublicUrl(data.path);
    return {
      ok: true,
      url: publicUrl.publicUrl,
      path: data.path,
      bucket: options.bucket,
      width: encoded.width,
      height: encoded.height,
      bytes: encoded.blob.size,
      contentType,
    };
  } catch (error) {
    console.error("[admin] upload failed", error);
    return { ok: false, message: describeAdminError(error).message };
  }
}

/**
 * The bucket + object path of one of OUR public storage URLs, or null for anything else
 * (e.g. the seed images under /images/…, which live in the repo and must never be "deleted").
 */
export function storageObjectFromUrl(url: string): { bucket: ImageBucket; path: string } | null {
  if (!supabaseStoragePublicPrefix || typeof url !== "string" || !url.startsWith(supabaseStoragePublicPrefix)) return null;
  const rest = url.slice(supabaseStoragePublicPrefix.length).split(/[?#]/)[0];
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  const bucket = rest.slice(0, slash) as ImageBucket;
  let path: string;
  try {
    path = decodeURIComponent(rest.slice(slash + 1));
  } catch {
    return null;
  }
  if (!IMAGE_BUCKETS.includes(bucket) || !path || path.split("/").some((segment) => segment === "..")) return null;
  return { bucket, path };
}

/**
 * Delete uploaded images by URL (call AFTER the row that referenced them was saved). URLs that
 * aren't our storage are skipped. Never throws; `removed` counts the objects actually deleted.
 */
export async function removeImage(urls: string | readonly string[]): Promise<{ ok: true; removed: number } | UploadFailure> {
  const list = (Array.isArray(urls) ? urls : [urls]) as readonly string[];
  const objects = list.map(storageObjectFromUrl).filter((object): object is { bucket: ImageBucket; path: string } => object !== null);
  if (objects.length === 0) return { ok: true, removed: 0 };
  const supabase = getBrowserSupabase();
  if (!supabase) return { ok: false, message: NOT_CONFIGURED_MESSAGE };
  let removed = 0;
  for (const bucket of IMAGE_BUCKETS) {
    const paths = objects.filter((object) => object.bucket === bucket).map((object) => object.path);
    if (paths.length === 0) continue;
    try {
      const { data, error } = await supabase.storage.from(bucket).remove(paths);
      if (error) {
        console.error("[admin] image delete failed", error);
        return { ok: false, message: "Couldn't delete the old image file (it stays in storage; nothing on the site uses it)." };
      }
      removed += Array.isArray(data) ? data.length : 0;
    } catch (error) {
      console.error("[admin] image delete failed", error);
      return { ok: false, message: describeAdminError(error, { action: "delete" }).message };
    }
  }
  return { ok: true, removed };
}

/** URLs that were in `before` but aren't in `after` — candidates for removeImage() after a save. */
export function unreferencedImages(before: readonly (string | null | undefined)[], after: readonly (string | null | undefined)[]): string[] {
  const keep = new Set(after.filter(Boolean));
  return [...new Set(before.filter((url): url is string => Boolean(url) && !keep.has(url)))];
}
