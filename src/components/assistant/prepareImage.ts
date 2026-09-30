"use client";

/**
 * Photo input for the assistant (blueprint §10.14 "Images"): refuse sources over 24 MB; decode;
 * draw onto a WHITE canvas (transparent PNGs don't turn black); walk a descending ladder of
 * [long edge, JPEG quality] until the base64 is under 400k characters (the route's cap). A
 * separate tiny thumbnail is produced for the transcript — it NEVER leaves the browser (it is not
 * even stored). Typed errors, so each failure gets its own copy.
 */

export const MAX_SOURCE_BYTES = 24 * 1024 * 1024;
const MAX_BASE64_CHARS = 400_000;
const LADDER: readonly (readonly [number, number])[] = [
  [896, 0.72],
  [896, 0.6],
  [768, 0.6],
  [640, 0.55],
  [512, 0.5],
];
const THUMB_EDGE = 160;
const JPEG_PREFIX = "data:image/jpeg;base64,";

export type PrepareImageErrorKind = "too_large" | "not_image" | "codec" | "encode";

export class PrepareImageError extends Error {
  constructor(readonly kind: PrepareImageErrorKind) {
    super(kind);
    this.name = "PrepareImageError";
  }
}

export const PREPARE_IMAGE_COPY: Record<PrepareImageErrorKind, string> = {
  too_large: "That photo is over 24 MB. Please choose a smaller one.",
  not_image: "That file isn't a photo. Please choose a JPG, PNG or similar image.",
  codec: "Your browser couldn't open that photo. Try a JPG or PNG, or a screenshot of it.",
  encode: "That photo couldn't be prepared for sending. Please try another one.",
};

export type PreparedImage = {
  /** base64 JPEG (no data: prefix) — what POST /api/assistant receives. */
  data: string;
  /** Tiny data-URL preview for the transcript. Local only. */
  thumb: string;
};

type Source = { image: CanvasImageSource; width: number; height: number; close: () => void };

async function decode(file: File): Promise<Source> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // fall through to <img> (older Safari)
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return { image: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new PrepareImageError("codec");
  }
}

function draw(source: Source, longEdge: number): HTMLCanvasElement {
  const scale = Math.min(1, longEdge / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new PrepareImageError("encode");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source.image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (file.size > MAX_SOURCE_BYTES) throw new PrepareImageError("too_large");
  if (file.type && !file.type.startsWith("image/")) throw new PrepareImageError("not_image");
  const source = await decode(file);
  try {
    if (!source.width || !source.height) throw new PrepareImageError("codec");
    for (const [edge, quality] of LADDER) {
      const url = draw(source, edge).toDataURL("image/jpeg", quality);
      if (!url.startsWith(JPEG_PREFIX)) throw new PrepareImageError("encode");
      const data = url.slice(JPEG_PREFIX.length);
      if (data.length <= MAX_BASE64_CHARS) {
        const thumb = draw(source, THUMB_EDGE).toDataURL("image/jpeg", 0.6);
        return { data, thumb };
      }
    }
    throw new PrepareImageError("encode");
  } finally {
    source.close();
  }
}
