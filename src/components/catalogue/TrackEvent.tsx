"use client";

import { useEffect } from "react";
import { track, type EventType, type TrackProps } from "@/lib/analytics";
import { recordProductView } from "@/lib/viewed";

type Props = {
  type: EventType;
  productId?: number | null;
  value?: number | null;
  metadata?: TrackProps["metadata"];
  /** product_view only: also add the product to this session's browse trail (lib/viewed.ts). */
  recordView?: boolean;
};

/**
 * Fires one analytics event after the page mounts (blueprint §12.3 taxonomy), and again only
 * when the event itself changes (a new search, another product). Renders nothing. track() is
 * consent-aware and never throws (lib/analytics.ts, WP-H).
 */
export function TrackEvent({ type, productId = null, value = null, metadata, recordView = false }: Props) {
  const key = JSON.stringify([type, productId, value, metadata ?? null]);
  useEffect(() => {
    const [eventType, id, eventValue, meta] = JSON.parse(key) as [EventType, number | null, number | null, TrackProps["metadata"] | null];
    track(eventType, { productId: id, value: eventValue, metadata: meta ?? undefined });
    if (recordView && id) recordProductView(id);
  }, [key, recordView]);
  return null;
}
