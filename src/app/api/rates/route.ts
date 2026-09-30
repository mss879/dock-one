import { serverEnv } from "@/lib/env.server";
import { BASE_CURRENCY, FALLBACK_RATES, sanitizeRates } from "@/lib/currency-shared";

/**
 * GET /api/rates — display-currency rates per 1 LKR (blueprint §9.3). The upstream call is
 * cached for 12 h in the Next data cache; the response is CDN-cacheable. Any failure (API
 * down, bad shape, wrong base) falls back to the static table: rates are display-only.
 */

const TWELVE_HOURS = 43200;

type Payload = { base: typeof BASE_CURRENCY; rates: Record<string, number>; live: boolean };

async function fetchRates(): Promise<Payload> {
  try {
    const response = await fetch(serverEnv.fxApiUrl, {
      headers: { Accept: "application/json" },
      next: { revalidate: TWELVE_HOURS },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`FX API answered ${response.status}`);
    const body = (await response.json()) as { result?: string; base_code?: string; rates?: unknown };
    if (body.result && body.result !== "success") throw new Error(`FX API result "${body.result}"`);
    if (body.base_code && body.base_code.toUpperCase() !== BASE_CURRENCY) throw new Error(`FX API base is ${body.base_code}, expected ${BASE_CURRENCY}`);
    const { rates, live } = sanitizeRates(body.rates);
    return { base: BASE_CURRENCY, rates, live };
  } catch (error) {
    console.warn(`[rates] using fallback rates: ${error instanceof Error ? error.message : String(error)}`);
    return { base: BASE_CURRENCY, rates: FALLBACK_RATES, live: false };
  }
}

export async function GET() {
  const payload = await fetchRates();
  return Response.json(payload, {
    headers: {
      // Live rates: let the CDN keep them; fallback: short, so a recovered API shows up soon.
      "Cache-Control": payload.live ? `public, max-age=3600, s-maxage=${TWELVE_HOURS}, stale-while-revalidate=86400` : "public, max-age=300, s-maxage=600",
    },
  });
}
