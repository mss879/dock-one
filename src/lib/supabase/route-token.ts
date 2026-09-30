import "server-only";
import { createHmac } from "node:crypto";
import { isUsableSecret, serverEnv } from "@/lib/env.server";

/**
 * The `x-dockone-route` header the database's direct-call brake checks (`_trusted_route_call()`,
 * supabase/migrations/01_foundation.sql — blueprint P3): hex(HMAC-SHA256(key = RATE_LIMIT_SECRET,
 * "dockone-route-v1")). Only the SERVER-side clients send it, so a caller holding just the public
 * anon key who calls an RPC straight against PostgREST shares a small store-wide budget instead of
 * the routes' per-IP limits. The raw secret never leaves the server; without a usable secret no
 * header is sent (and the database, with no secret either, treats every call as trusted).
 */
const secret = serverEnv.rateLimitSecret;

export const ROUTE_HEADERS: Readonly<Record<string, string>> = isUsableSecret(secret)
  ? { "x-dockone-route": createHmac("sha256", secret).update("dockone-route-v1").digest("hex") }
  : {};
