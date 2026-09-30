import "server-only";
import { NextResponse } from "next/server";

/** API responses are per-request and often per-person: never cache them anywhere. */
export const NO_STORE_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store, max-age=0",
};

/** Shopper-facing copy shared by every route. */
export const MESSAGES = {
  invalid: "Invalid request.",
  tooLarge: "That request is too large.",
  slowDown: "You're going a little fast. Please wait a moment and try again.",
  unavailable: "This service is temporarily unavailable. Please try again shortly.",
  notConfigured: "This feature is not set up yet.",
  generic: "Something went wrong. Please try again.",
  forbidden: "You don't have permission to do that.",
} as const;

/** JSON response with no-store headers. `json({ error }, 422)`. */
export function json<T>(data: T, status = 200, init?: { headers?: Record<string, string> }): NextResponse<T> {
  return NextResponse.json(data, { status, headers: { ...NO_STORE_HEADERS, ...init?.headers } });
}

/** Error body in the one shape every route uses: `{ error: string, code?: string }`. */
export function jsonError(message: string, status: number, code?: string | null): NextResponse<{ error: string; code?: string }> {
  return json(code ? { error: message, code } : { error: message }, status);
}

/** 204 for beacons (analytics) — the body is ignored by the caller. */
export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204, headers: NO_STORE_HEADERS });
}
