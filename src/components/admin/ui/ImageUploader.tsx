"use client";

import { ArrowLeft, ArrowRight, ImagePlus, LoaderCircle, Star, Trash2, Upload } from "lucide-react";
import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import { IMAGE_ACCEPT, uploadImage, type ImageBucket } from "@/lib/admin/storage";
import { AdminButton, IconButton } from "./Button";

/**
 * Image fields backed by lib/admin/storage (browser → WebP → Supabase Storage → public URL).
 *
 *   <ImageUploader label="Stage image" value={form.stage_image_url} onChange={(url) => set("stage_image_url", url)}
 *                  bucket="content-images" prefix={`categories/${form.id}`} />
 *
 *   <ImageGalleryUploader value={form.image_urls} onChange={(urls) => set("image_urls", urls)}
 *                         bucket="product-images" prefix={`products/${product.id}`} />
 *   // save image_url = image_urls[0] (the first image is the main one — blueprint §11.2)
 *
 * Uploading puts the file in storage immediately, but nothing on the site uses it until the
 * form is SAVED. Removing an image only edits the list; delete orphaned files after the save
 * with removeImage(unreferencedImages(before, after)) if you want to reclaim space.
 */

type Pending = { id: number; name: string; error?: string };

function useUploads(bucket: ImageBucket, prefix: string, maxDimension?: number, onBusyChange?: (busy: boolean) => void) {
  const [pending, setPending] = useState<Pending[]>([]);
  const counter = useRef(0);
  const busy = pending.some((item) => !item.error);

  // Tell the editor while an upload is in flight, so it can hold Save until the image exists.
  const notify = useRef(onBusyChange);
  useEffect(() => {
    notify.current = onBusyChange;
  }, [onBusyChange]);
  useEffect(() => {
    notify.current?.(busy);
  }, [busy]);
  useEffect(() => () => notify.current?.(false), []);

  const run = async (files: File[], onUploaded: (url: string) => void) => {
    for (const file of files) {
      const id = ++counter.current;
      setPending((list) => [...list, { id, name: file.name }]);
      const result = await uploadImage(file, { bucket, prefix, maxDimension });
      if (result.ok) {
        onUploaded(result.url);
        setPending((list) => list.filter((item) => item.id !== id));
      } else {
        setPending((list) => list.map((item) => (item.id === id ? { ...item, error: result.message } : item)));
      }
    }
  };

  const dismiss = (id: number) => setPending((list) => list.filter((item) => item.id !== id));
  return { pending, busy, run, dismiss };
}

function filesFrom(list: FileList | null | undefined): File[] {
  return list ? Array.from(list).filter((file) => file.type.startsWith("image/") || file.type === "") : [];
}

function UploadStatus({ pending, onDismiss }: { pending: Pending[]; onDismiss: (id: number) => void }) {
  if (pending.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1" aria-live="polite">
      {pending.map((item) => (
        <li key={item.id} className={`flex items-start gap-2 text-xs leading-5 ${item.error ? "text-adm-ink" : "text-adm-mute"}`} role={item.error ? "alert" : undefined}>
          {item.error ? (
            <span aria-hidden className="mt-0.5 grid size-4 shrink-0 place-items-center bg-adm-ink font-mono text-[10px] text-white">
              !
            </span>
          ) : (
            <LoaderCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 animate-spin" />
          )}
          <span className="min-w-0 flex-1">
            <span className="font-mono">{item.name}</span> — {item.error ?? "converting to WebP and uploading…"}
          </span>
          {item.error && (
            <button type="button" onClick={() => onDismiss(item.id)} className="shrink-0 underline hover:text-adm-accent-ink">
              Dismiss
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function useDropTarget(onFiles: (files: File[]) => void, disabled: boolean) {
  const [over, setOver] = useState(false);
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
  return {
    over,
    handlers: {
      onDragOver: (event: DragEvent) => {
        if (disabled || !hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: DragEvent) => {
        if (disabled || !hasFiles(event)) return;
        event.preventDefault();
        setOver(false);
        onFiles(filesFrom(event.dataTransfer.files));
      },
    },
  };
}

const aspects = { square: "aspect-square", landscape: "aspect-[16/9]", wide: "aspect-[21/9]", portrait: "aspect-[3/4]" } as const;

/** One image (a stage image, a hero slide, a cut-out). */
export function ImageUploader({
  value,
  onChange,
  bucket,
  prefix,
  label = "Image",
  hint,
  aspect = "landscape",
  fit = "cover",
  disabled = false,
  maxDimension,
  onBusyChange,
}: {
  value: string | null;
  onChange: (url: string | null) => void;
  bucket: ImageBucket;
  prefix: string;
  /** Accessible name for the controls ("Stage image"). */
  label?: string;
  hint?: ReactNode;
  aspect?: keyof typeof aspects;
  /** "contain" for transparent cut-outs. */
  fit?: "cover" | "contain";
  disabled?: boolean;
  maxDimension?: number;
  /** Called with true while an upload is in flight and false when it settles (hold Save meanwhile). */
  onBusyChange?: (busy: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const uploads = useUploads(bucket, prefix, maxDimension, onBusyChange);
  const drop = useDropTarget((files) => void uploads.run(files.slice(0, 1), onChange), disabled);

  return (
    <div>
      <div
        {...drop.handlers}
        className={`relative flex ${aspects[aspect]} w-full max-w-md items-center justify-center overflow-hidden border ${
          drop.over ? "border-adm-accent bg-adm-accent-soft" : value ? "border-adm-line bg-adm-panel-2" : "border-dashed border-adm-line-strong bg-adm-panel-2"
        }`}
      >
        {value ? (
          // Admin preview of a storage/seed URL: a plain <img> (no optimiser round trip, any size).
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt={`${label} preview`} className={`size-full ${fit === "contain" ? "object-contain p-3" : "object-cover"}`} />
        ) : (
          <div className="flex flex-col items-center gap-2 px-4 text-center text-adm-mute">
            <ImagePlus aria-hidden className="size-6" />
            <p className="text-xs leading-5">Drop an image here or use the button below.</p>
          </div>
        )}
        {uploads.busy && (
          <div className="absolute inset-0 grid place-items-center bg-adm-panel/70">
            <LoaderCircle aria-hidden className="size-6 animate-spin text-adm-ink" />
          </div>
        )}
      </div>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={IMAGE_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        disabled={disabled}
        onChange={(event) => {
          const files = filesFrom(event.target.files);
          event.target.value = "";
          if (files.length) void uploads.run(files.slice(0, 1), onChange);
        }}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <AdminButton size="sm" icon={<Upload aria-hidden className="size-3.5" />} disabled={disabled} loading={uploads.busy} onClick={() => inputRef.current?.click()}>
          {value ? `Replace ${label.toLowerCase()}` : `Upload ${label.toLowerCase()}`}
        </AdminButton>
        {value && (
          <AdminButton size="sm" variant="ghost" icon={<Trash2 aria-hidden className="size-3.5" />} disabled={disabled || uploads.busy} onClick={() => onChange(null)}>
            Remove
          </AdminButton>
        )}
      </div>
      {hint && <p className="mt-1.5 text-xs leading-5 text-adm-mute">{hint}</p>}
      <UploadStatus pending={uploads.pending} onDismiss={uploads.dismiss} />
    </div>
  );
}

/**
 * An ordered gallery (product images). The first image is the main one. Reorder with the
 * arrow buttons (keyboard) or by dragging; remove; upload several at once (processed in order).
 */
export function ImageGalleryUploader({
  value,
  onChange,
  bucket,
  prefix,
  max = 12,
  label = "Images",
  hint,
  disabled = false,
  maxDimension,
  onBusyChange,
}: {
  value: readonly string[];
  onChange: (urls: string[]) => void;
  bucket: ImageBucket;
  prefix: string;
  max?: number;
  label?: string;
  hint?: ReactNode;
  disabled?: boolean;
  maxDimension?: number;
  /** Called with true while an upload is in flight and false when it settles (hold Save meanwhile). */
  onBusyChange?: (busy: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const uploads = useUploads(bucket, prefix, maxDimension, onBusyChange);

  // Uploads finish one by one; each must append to the LATEST list, not the one captured at start.
  const latest = useRef<string[]>([...value]);
  useEffect(() => {
    latest.current = [...value];
  }, [value]);

  // Files accepted but not finished yet (so two quick batches can't exceed `max` together).
  const inFlight = useRef(0);
  const room = Math.max(0, max - value.length);
  const add = (files: File[]) => {
    if (files.length === 0) return;
    const accepted = files.slice(0, Math.max(0, max - latest.current.length - inFlight.current));
    setNotice(accepted.length < files.length ? `Only ${max} images are allowed — ${files.length - accepted.length} skipped.` : null);
    if (accepted.length === 0) return;
    inFlight.current += accepted.length;
    void uploads
      .run(accepted, (url) => {
        latest.current = [...latest.current, url];
        onChange(latest.current);
      })
      .finally(() => {
        inFlight.current = Math.max(0, inFlight.current - accepted.length);
      });
  };
  const drop = useDropTarget(add, disabled || room === 0);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= value.length || from === to) return;
    const next = [...value];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };

  return (
    <div>
      <ol
        {...drop.handlers}
        aria-label={label}
        // auto-fill by the CONTAINER's width (not the viewport): every tile stays wide enough for
        // its four controls, whether the gallery sits in a full-width form or a narrow column.
        className={`grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2 border p-2 ${drop.over ? "border-adm-accent bg-adm-accent-soft" : "border-dashed border-adm-line-strong bg-adm-panel-2"}`}
      >
        {value.map((url, index) => (
          <li
            key={`${url}-${index}`}
            draggable={!disabled}
            onDragStart={(event) => {
              setDragIndex(index);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", String(index));
            }}
            onDragOver={(event) => {
              if (dragIndex === null) return;
              event.preventDefault();
              event.stopPropagation();
            }}
            onDrop={(event) => {
              if (dragIndex === null) return;
              event.preventDefault();
              event.stopPropagation();
              move(dragIndex, index);
              setDragIndex(null);
            }}
            onDragEnd={() => setDragIndex(null)}
            className={`group relative border bg-adm-panel ${index === 0 ? "border-adm-ink" : "border-adm-line"} ${dragIndex === index ? "opacity-50" : ""}`}
          >
            <div className="aspect-square overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt={`${label} ${index + 1}${index === 0 ? " (main)" : ""}`} className="size-full object-contain" draggable={false} />
            </div>
            {index === 0 && (
              <span className="absolute top-1 left-1 bg-adm-ink px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide text-white uppercase">Main</span>
            )}
            <div className="flex items-center justify-between border-t border-adm-line px-1 py-0.5">
              <span className="font-mono text-[11px] text-adm-mute">{index + 1}</span>
              <span className="flex items-center">
                <IconButton size="sm" label={`Move image ${index + 1} earlier`} icon={<ArrowLeft className="size-3.5" />} disabled={disabled || index === 0} onClick={() => move(index, index - 1)} />
                <IconButton
                  size="sm"
                  label={`Move image ${index + 1} later`}
                  icon={<ArrowRight className="size-3.5" />}
                  disabled={disabled || index === value.length - 1}
                  onClick={() => move(index, index + 1)}
                />
                <IconButton size="sm" label={`Make image ${index + 1} the main image`} icon={<Star className="size-3.5" />} disabled={disabled || index === 0} onClick={() => move(index, 0)} />
                <IconButton
                  size="sm"
                  label={`Remove image ${index + 1}`}
                  icon={<Trash2 className="size-3.5" />}
                  disabled={disabled}
                  onClick={() => onChange(value.filter((_, i) => i !== index))}
                />
              </span>
            </div>
          </li>
        ))}
        {room > 0 && (
          <li className="flex aspect-square flex-col items-center justify-center gap-2 border border-dashed border-adm-line-strong bg-adm-panel p-2 text-center">
            {uploads.busy ? <LoaderCircle aria-hidden className="size-5 animate-spin text-adm-ink" /> : <ImagePlus aria-hidden className="size-5 text-adm-mute" />}
            <AdminButton size="sm" disabled={disabled} loading={uploads.busy} onClick={() => inputRef.current?.click()}>
              Add images
            </AdminButton>
            <span className="text-[11px] leading-4 text-adm-mute">or drop them here</span>
          </li>
        )}
      </ol>
      <input
        ref={inputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        disabled={disabled}
        onChange={(event) => {
          const files = filesFrom(event.target.files);
          event.target.value = "";
          add(files);
        }}
      />
      <p className="mt-1.5 text-xs leading-5 text-adm-mute">
        {hint ?? "The first image is the main one on cards and the product page."} {value.length}/{max}.
      </p>
      {notice && (
        <p role="status" className="mt-1 text-xs text-adm-ink">
          {notice}
        </p>
      )}
      <UploadStatus pending={uploads.pending} onDismiss={uploads.dismiss} />
    </div>
  );
}
